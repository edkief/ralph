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
