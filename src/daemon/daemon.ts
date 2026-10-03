import { hostname } from 'node:os';
import { clearDaemonRequest, readDaemonRequest, readDaemonState, writeDaemonState, type DaemonState } from './control.js';
import type { Logger } from '../report/logger.js';

/** How often the daemon looks for a request. */
const POLL_MS = 500;
/** How often it rewrites its state, so a reader on another host knows it is up. */
const HEARTBEAT_MS = 5_000;

/** How a batch ended, kept in the daemon's state for the web UI and `ralph daemon status`. */
export interface BatchOutcome {
  status: string;
  message: string;
}

export interface DaemonLoopArgs {
  ralphRoot: string;
  logger: Logger;
  /** Aborted to shut the daemon down, e.g. on SIGTERM. A batch in progress is interrupted. */
  signal: AbortSignal;
  /**
   * Run one batch of `iterations`. `interrupt` aborts when the daemon is shut
   * down meanwhile. Whatever it resolves or throws, the daemon goes idle after.
   */
  runBatch(iterations: number, interrupt: AbortSignal): Promise<BatchOutcome>;
  defaultIterations: number;
  /** Run a first batch at once, of this many iterations, rather than wait to be asked. */
  start?: number;
  uiUrl?: string;
  pollMs?: number;
  heartbeatMs?: number;
}

/**
 * The daemon's life: idle until asked to run a batch, the batch, idle again,
 * until asked to shut down. A batch is a whole run of the loop; pausing it is
 * the stop request every run takes, and however it ends, the daemon stays up.
 */
export async function daemonLoop(args: DaemonLoopArgs): Promise<void> {
  const { ralphRoot, logger } = args;
  const pollMs = args.pollMs ?? POLL_MS;
  const heartbeatMs = args.heartbeatMs ?? HEARTBEAT_MS;
  const startedAt = new Date().toISOString();
  const state: DaemonState = {
    pid: process.pid,
    hostname: hostname(),
    startedAt,
    updatedAt: startedAt,
    status: 'idle',
    defaultIterations: args.defaultIterations,
    batch: null,
    lastBatch: null,
    ...(args.uiUrl ? { uiUrl: args.uiUrl } : {}),
  };
  let lastWrite = 0;
  const save = (patch: Partial<DaemonState> = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    writeDaemonState(ralphRoot, state);
    lastWrite = Date.now();
  };

  // Requests left for a daemon that is gone mean nothing to this one.
  clearDaemonRequest(ralphRoot);

  const shutdown = new AbortController();
  const stopping = AbortSignal.any([args.signal, shutdown.signal]);
  let next: number | undefined = args.start;
  let wake: (() => void) | undefined;

  const tick = () => {
    const request = readDaemonRequest(ralphRoot);
    if (request) {
      clearDaemonRequest(ralphRoot);
      if (request.kind === 'shutdown') {
        logger.warn(
          state.status === 'running' ? 'shutdown requested: stopping the batch now, then exiting' : 'shutdown requested',
        );
        shutdown.abort();
      } else if (state.status !== 'idle' || next !== undefined) {
        logger.warn('run request ignored: a batch is already running');
      } else {
        next = request.iterations ?? args.defaultIterations;
        wake?.();
      }
    }
    if (Date.now() - lastWrite >= heartbeatMs) save();
  };
  const timer = setInterval(tick, pollMs);
  stopping.addEventListener('abort', () => wake?.(), { once: true });

  save();
  if (next === undefined) {
    logger.info('daemon idle: run a batch from the web UI or with `ralph daemon run`', {
      pid: process.pid,
      defaultIterations: args.defaultIterations,
    });
  }
  try {
    while (!stopping.aborted) {
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (stopping.aborted || next !== undefined) resolve();
        });
        wake = undefined;
        continue;
      }
      const iterations = next;
      save({ status: 'running', batch: { iterations, startedAt: new Date().toISOString() } });
      logger.info('daemon running a batch', { iterations });
      let outcome: BatchOutcome;
      try {
        outcome = await args.runBatch(iterations, stopping);
      } catch (cause) {
        outcome = { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
        logger.error('batch failed', { error: outcome.message });
      }
      next = undefined;
      state.lastBatch = { ...outcome, endedAt: new Date().toISOString() };
      if (stopping.aborted) break;
      save({ status: 'idle', batch: null });
      logger.info('daemon idle', { last: outcome.status });
    }
  } finally {
    clearInterval(timer);
    save({ status: 'stopping' });
  }
}

/** Mark this process's daemon gone, once everything it held is closed. */
export function markStopped(ralphRoot: string): void {
  const state = readDaemonState(ralphRoot);
  if (state?.pid !== process.pid || state.hostname !== hostname()) return;
  writeDaemonState(ralphRoot, { ...state, status: 'stopped', batch: null, updatedAt: new Date().toISOString() });
}
