import { describe, expect, it } from 'vitest';
import { Watchdog, describeTrip } from '../src/loop/watchdog.js';

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const options = (now: () => number) => ({
  iterationMs: 60_000,
  inactivityMs: 10_000,
  maxProviderRetries: 2,
  now,
});

describe('Watchdog', () => {
  it('stays quiet while the agent is working', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    time.advance(9_000);
    expect(watchdog.check()).toBeNull();
  });

  it('trips on inactivity', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    time.advance(10_000);
    expect(watchdog.check()).toBe('inactivity');
  });

  it('activity resets the inactivity window', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    time.advance(9_000);
    watchdog.recordActivity();
    time.advance(9_000);
    expect(watchdog.check()).toBeNull();
  });

  it('does not trip on inactivity while the conversation is compacted', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    watchdog.recordActivity();
    watchdog.beginCompaction();
    time.advance(30_000);
    expect(watchdog.check()).toBeNull();
    time.advance(30_000);
    expect(watchdog.check()).toBe('iteration-timeout');
  });

  it('watches for inactivity again once activity follows a compaction', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    watchdog.beginCompaction();
    time.advance(20_000);
    watchdog.recordActivity();
    time.advance(10_000);
    expect(watchdog.check()).toBe('inactivity');
  });

  it('trips on the hard iteration budget even while active', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    for (let i = 0; i < 10; i += 1) {
      time.advance(6_000);
      watchdog.recordActivity();
    }
    expect(watchdog.check()).toBe('iteration-timeout');
  });

  it('trips on a retry storm, the silent provider failure', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    watchdog.recordProviderRetry();
    watchdog.recordProviderRetry();
    expect(watchdog.check()).toBeNull();
    watchdog.recordProviderRetry();
    expect(watchdog.check()).toBe('retry-storm');
  });

  it('a successful step clears the retry counter', () => {
    const time = clock();
    const watchdog = new Watchdog(options(time.now));
    watchdog.recordProviderRetry();
    watchdog.recordProviderRetry();
    watchdog.recordActivity();
    watchdog.recordProviderRetry();
    expect(watchdog.check()).toBeNull();
  });

  it('describes trips in terms a human can act on', () => {
    const time = clock();
    expect(describeTrip('retry-storm', options(time.now))).toMatch(/retried more than 2/);
  });
});

describe('Watchdog wrap-up phase', () => {
  const wrapUpOptions = (now: () => number) => ({ ...options(now), wrapUpMs: 30_000 });

  it('replaces the iteration budget with the wrap-up budget', () => {
    const time = clock();
    const watchdog = new Watchdog(wrapUpOptions(time.now));
    time.advance(60_000);
    expect(watchdog.check()).toBe('iteration-timeout');

    watchdog.beginWrapUp();
    expect(watchdog.wrappingUp).toBe(true);
    expect(watchdog.check()).toBeNull();

    for (let i = 0; i < 5; i += 1) {
      time.advance(5_000);
      watchdog.recordActivity();
    }
    expect(watchdog.check()).toBeNull();
    time.advance(5_000);
    expect(watchdog.check()).toBe('wrap-up-timeout');
  });

  it('starts the wrap-up with a fresh inactivity window, and still trips on it', () => {
    const time = clock();
    const watchdog = new Watchdog(wrapUpOptions(time.now));
    time.advance(10_000);
    expect(watchdog.check()).toBe('inactivity');

    watchdog.beginWrapUp();
    expect(watchdog.check()).toBeNull();
    time.advance(10_000);
    expect(watchdog.check()).toBe('inactivity');
  });

  it('states budgets in minutes, or seconds when they are short', () => {
    expect(describeTrip('iteration-timeout', { ...options(Date.now), iterationMs: 2_700_000 })).toBe(
      'Iteration exceeded its 45m budget',
    );
    expect(describeTrip('iteration-timeout', { ...options(Date.now), iterationMs: 90_000 })).toBe(
      'Iteration exceeded its 1m30s budget',
    );
    expect(describeTrip('wrap-up-timeout', { ...options(Date.now), wrapUpMs: 2_000 })).toBe(
      'Wrap-up exceeded its 2s budget',
    );
  });

  it('describes a wrap-up timeout', () => {
    expect(describeTrip('wrap-up-timeout', { ...options(Date.now), wrapUpMs: 600_000 })).toBe(
      'Wrap-up exceeded its 10m budget',
    );
  });
});
