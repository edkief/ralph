import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  daemonLive,
  daemonRequestPath,
  DaemonRequestError,
  liveDaemon,
  readDaemonRequest,
  readDaemonState,
  requestRun,
  requestShutdown,
  writeDaemonRequest,
  writeDaemonState,
  type DaemonState,
} from '../src/daemon/control.js';
import { daemonLoop, markStopped } from '../src/daemon/daemon.js';
import { Logger } from '../src/report/logger.js';
import { controlDaemon } from '../src/daemon/command.js';
import { readStopRequest } from '../src/human/request.js';
import { ConfigSchema } from '../src/config/schema.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WriteStream });
const folder = () => mkdtempSync(resolve(tmpdir(), 'ralph-daemon-'));
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await tick(5);
  }
}

const state = (patch: Partial<DaemonState> = {}): DaemonState => ({
  pid: process.pid,
  hostname: 'elsewhere',
  startedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: new Date().toISOString(),
  status: 'idle',
  defaultIterations: 10,
  batch: null,
  ...patch,
});

/** A daemon whose batches end when the test says so. */
function harness(options: { start?: number; fail?: boolean } = {}) {
  const root = folder();
  const shutdown = new AbortController();
  const batches: number[] = [];
  let finish: (() => void) | undefined;
  let interrupted = false;
  const done = daemonLoop({
    ralphRoot: root,
    logger,
    signal: shutdown.signal,
    defaultIterations: 7,
    pollMs: 5,
    heartbeatMs: 50,
    ...(options.start !== undefined ? { start: options.start } : {}),
    runBatch: async (iterations, interrupt) => {
      batches.push(iterations);
      if (options.fail) throw new Error('preflight failed');
      return new Promise((resolve) => {
        finish = () => resolve({ status: 'complete', message: 'All 3 tasks pass' });
        interrupt.addEventListener('abort', () => {
          interrupted = true;
          resolve({ status: 'interrupted', message: 'Interrupted' });
        });
      });
    },
  });
  return {
    root,
    batches,
    done,
    shutdown,
    status: () => readDaemonState(root)?.status,
    finish: () => finish?.(),
    interrupted: () => interrupted,
  };
}

describe('daemon control files', () => {
  it('round-trips its state and requests', () => {
    const root = folder();
    expect(readDaemonState(root)).toBeUndefined();
    writeDaemonState(root, state());
    expect(readDaemonState(root)).toEqual(state({ updatedAt: readDaemonState(root)!.updatedAt }));
    writeDaemonRequest(root, { kind: 'run', iterations: 3 }, 'cli');
    expect(readDaemonRequest(root)).toEqual({ kind: 'run', iterations: 3 });
  });

  it('takes a daemon on this host as up while its process is', () => {
    expect(daemonLive(state({ hostname: hostname() }))).toBe(true);
    expect(daemonLive(state({ hostname: hostname(), pid: 2 ** 22 + 12345 }))).toBe(false);
    expect(daemonLive(state({ hostname: hostname(), status: 'stopped' }))).toBe(false);
  });

  it('takes a daemon on another host as up while its heartbeat is fresh', () => {
    const now = Date.parse('2026-10-01T00:00:30.000Z');
    expect(daemonLive(state({ updatedAt: '2026-10-01T00:00:00.000Z' }), now)).toBe(true);
    expect(daemonLive(state({ updatedAt: '2026-09-30T23:58:00.000Z' }), now)).toBe(false);
  });

  it('refuses a run without an idle daemon, and a shutdown without one', () => {
    const root = folder();
    expect(() => requestRun(root, 3, 'cli')).toThrow(DaemonRequestError);
    expect(() => requestShutdown(root, 'cli')).toThrow(DaemonRequestError);
    writeDaemonState(root, state({ status: 'running', batch: { iterations: 3, startedAt: '2026-10-01T00:00:00.000Z' } }));
    expect(() => requestRun(root, 3, 'cli')).toThrow(/already running/);
    expect(existsSync(daemonRequestPath(root))).toBe(false);
    writeDaemonState(root, state());
    requestRun(root, undefined, 'ui');
    expect(readDaemonRequest(root)).toEqual({ kind: 'run' });
    expect(liveDaemon(root)?.status).toBe('idle');
  });
});

describe('the daemon loop', () => {
  it('waits idle, runs a batch when asked, then goes idle again', async () => {
    const daemon = harness();
    await until(() => daemon.status() === 'idle');
    await tick();
    expect(daemon.batches).toEqual([]);

    writeDaemonRequest(daemon.root, { kind: 'run', iterations: 3 }, 'cli');
    await until(() => daemon.status() === 'running');
    expect(readDaemonState(daemon.root)?.batch?.iterations).toBe(3);
    daemon.finish();
    await until(() => daemon.status() === 'idle');
    expect(readDaemonState(daemon.root)?.lastBatch).toMatchObject({ status: 'complete', message: 'All 3 tasks pass' });

    writeDaemonRequest(daemon.root, { kind: 'run' }, 'ui');
    await until(() => daemon.batches.length === 2);
    expect(daemon.batches).toEqual([3, 7]);
    daemon.finish();
    await until(() => daemon.status() === 'idle');

    writeDaemonRequest(daemon.root, { kind: 'shutdown' }, 'cli');
    await daemon.done;
    expect(daemon.status()).toBe('stopping');
    markStopped(daemon.root);
    expect(daemon.status()).toBe('stopped');
    expect(liveDaemon(daemon.root)).toBeUndefined();
  });

  it('runs a first batch at once when told to start', async () => {
    const daemon = harness({ start: 4 });
    await until(() => daemon.batches.length === 1);
    expect(daemon.batches).toEqual([4]);
    daemon.finish();
    await until(() => daemon.status() === 'idle');
    daemon.shutdown.abort();
    await daemon.done;
  });

  it('ignores a run request while a batch runs', async () => {
    const daemon = harness({ start: 2 });
    await until(() => daemon.status() === 'running');
    writeDaemonRequest(daemon.root, { kind: 'run', iterations: 9 }, 'cli');
    await until(() => !existsSync(daemonRequestPath(daemon.root)));
    daemon.finish();
    await until(() => daemon.status() === 'idle');
    await tick();
    expect(daemon.batches).toEqual([2]);
    daemon.shutdown.abort();
    await daemon.done;
  });

  it('stays up when a batch fails', async () => {
    const daemon = harness({ start: 2, fail: true });
    await until(() => daemon.batches.length === 1 && daemon.status() === 'idle');
    expect(readDaemonState(daemon.root)?.lastBatch).toMatchObject({ status: 'failed', message: 'preflight failed' });
    writeDaemonRequest(daemon.root, { kind: 'run' }, 'cli');
    await until(() => daemon.batches.length === 2);
    daemon.shutdown.abort();
    await daemon.done;
  });

  it('interrupts the batch in progress when shut down', async () => {
    const daemon = harness({ start: 2 });
    await until(() => daemon.status() === 'running');
    writeDaemonRequest(daemon.root, { kind: 'shutdown' }, 'cli');
    await daemon.done;
    expect(daemon.interrupted()).toBe(true);
    expect(daemon.status()).toBe('stopping');
  });

  it('forgets a request left for a daemon that is gone', async () => {
    const root = folder();
    writeDaemonRequest(root, { kind: 'run', iterations: 3 }, 'cli');
    const shutdown = new AbortController();
    const batches: number[] = [];
    const done = daemonLoop({
      ralphRoot: root,
      logger,
      signal: shutdown.signal,
      defaultIterations: 7,
      pollMs: 5,
      runBatch: async (iterations) => {
        batches.push(iterations);
        return { status: 'complete', message: '' };
      },
    });
    await tick(50);
    expect(batches).toEqual([]);
    shutdown.abort();
    await done;
  });
});

describe('ralph daemon pause', () => {
  it('parks the run in progress with --park', async () => {
    const root = folder();
    const run = resolve(root, '.ralph', 'history', '20261003-101500-abcd');
    mkdirSync(run, { recursive: true });
    writeFileSync(
      resolve(run, 'state.json'),
      JSON.stringify({ runId: '20261003-101500-abcd', status: 'running', pid: process.pid, hostname: hostname(), startedAt: 't', updatedAt: 't' }),
    );
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(await controlDaemon({ config: ConfigSchema.parse({ projectRoot: root }), action: 'pause', now: false, park: true })).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(readStopRequest(resolve(root, '.ralph'))).toEqual({ mode: 'park' });
  });
});
