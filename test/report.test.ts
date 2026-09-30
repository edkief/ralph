import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleReporter } from '../src/report/console.js';
import { Logger } from '../src/report/logger.js';
import { formatClock, formatTimestamp } from '../src/report/time.js';

function capture(): { stream: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const stream = { write: (chunk: string) => chunks.push(chunk) > 0 } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join('') };
}

let savedTz: string | undefined;

beforeEach(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
});

afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('time formatting', () => {
  it('uses the local time zone', () => {
    const date = new Date('2026-09-29T12:03:04Z');
    expect(formatClock(date)).toBe('08:03:04');
    expect(formatTimestamp(date)).toBe('2026-09-29 08:03:04 UTC-04:00 (America/New_York)');
  });
});

describe('Logger', () => {
  it('stamps text lines with the local time', () => {
    const out = capture();
    const logger = new Logger({ stream: out.stream, color: false, now: () => new Date('2026-09-29T12:03:04Z') });
    logger.warn('retrying iteration', { attempt: 1 });
    expect(out.text()).toBe('08:03:04 warn retrying iteration attempt=1\n');
  });

  it('keeps UTC ISO times in JSON lines', () => {
    const out = capture();
    const logger = new Logger({ stream: out.stream, format: 'json', now: () => new Date('2026-09-29T12:03:04Z') });
    logger.info('hello');
    expect(JSON.parse(out.text())).toMatchObject({ time: '2026-09-29T12:03:04.000Z', message: 'hello' });
  });

  it('runs the hook before writing, and only for lines it writes', () => {
    const out = capture();
    const logger = new Logger({ stream: out.stream, level: 'info', color: false });
    let calls = 0;
    logger.beforeWrite(() => calls++);
    logger.debug('hidden');
    logger.info('shown');
    expect(calls).toBe(1);
  });
});

describe('Logger sinks', () => {
  it('receive the lines that pass the level, until detached', () => {
    const out = capture();
    const logger = new Logger({ stream: out.stream, level: 'info', now: () => new Date('2026-09-29T12:03:04Z') });
    const entries: unknown[] = [];
    const detach = logger.addSink((entry) => entries.push(entry));
    logger.debug('hidden');
    logger.warn('push failed', { remote: 'origin' });
    logger.info('plain');
    detach();
    logger.info('after');
    expect(entries).toEqual([
      { time: '2026-09-29T12:03:04.000Z', level: 'warn', message: 'push failed', fields: { remote: 'origin' } },
      { time: '2026-09-29T12:03:04.000Z', level: 'info', message: 'plain' },
    ]);
  });
});

describe('ConsoleReporter', () => {
  it('stamps iteration and status lines', () => {
    const out = capture();
    const reporter = new ConsoleReporter(out.stream, false, () => new Date('2026-09-29T12:03:04Z'));
    reporter.iterationStart(3, 10, 'TASK-1');
    reporter.status('reading files');
    expect(out.text()).toBe('\n08:03:04 Iteration 3/10 → TASK-1\n08:03:04   reading files\n');
  });

  it('marks an iteration that starts on a new local day', () => {
    const out = capture();
    let now = new Date('2026-09-30T03:59:00Z'); // 23:59 on the 29th in New York
    const reporter = new ConsoleReporter(out.stream, false, () => now);
    reporter.iterationStart(1, 10, null);
    now = new Date('2026-09-30T04:01:00Z');
    reporter.iterationStart(2, 10, null);
    expect(out.text()).toBe('\n23:59:00 Iteration 1/10\n\n── 2026-09-30 ──\n\n00:01:00 Iteration 2/10\n');
  });
});
