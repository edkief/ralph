import { hostname } from 'node:os';
import { clearDaemonRequest, readDaemonRequest, readDaemonState, writeDaemonState, type DaemonState } from './control.js';
import type { Logger } from '../report/logger.js';
import type { PlanMode } from '../init/record.js';

/** How often the daemon looks for a request. */
const POLL_MS = 500;
/** How often it rewrites its state, so a reader on another host knows it is up. */
const HEARTBEAT_MS = 5_000;

/** How a batch ended, kept in the daemon's state for the web UI and `ralph daemon status`. */
export interface BatchOutcome {
  status: string;
  message: string;
}

/** A planning interview the web UI asked for. */
export interface PlanRequest {
  id: string;
  mode: PlanMode;
  description: string;
}

/** What the daemon does next: a batch, or an interview. */
type Work = { kind: 'run'; iterations: number } | { kind: 'plan'; request: PlanRequest };

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
  /**
   * Hold a planning interview. `interrupt` aborts when the daemon is shut
   * down meanwhile. The session keeps its own record; whatever it resolves or
   * throws, the daemon goes idle after. Without it, plan requests are ignored.
   */
  runPlan?(request: PlanRequest, interrupt: AbortSignal): Promise<void>;
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
 * A planning interview takes the place of a batch: one thing at a time.
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
  let next = (args.start !== undefined ? { kind: 'run', iterations: args.start } : undefined) as Work | undefined;
  let wake: (() => void) | undefined;

  const tick = () => {
    const request = readDaemonRequest(ralphRoot);
    if (request) {
      clearDaemonRequest(ralphRoot);
      if (request.kind === 'shutdown') {
        logger.warn(
          state.status === 'running'
            ? 'shutdown requested: stopping the batch now, then exiting'
            : state.status === 'planning'
              ? 'shutdown requested: ending the interview, then exiting'
              : 'shutdown requested',
        );
        shutdown.abort();
      } else if (state.status !== 'idle' || next !== undefined) {
        logger.warn(`${request.kind} request ignored: ${state.status === 'planning' ? 'an interview is under way' : 'a batch is already running'}`);
      } else if (request.kind === 'plan') {
        if (args.runPlan) {
          next = { kind: 'plan', request: { id: request.id, mode: request.mode, description: request.description } };
          wake?.();
        } else {
          logger.warn('plan request ignored: this daemon does not plan');
        }
      } else {
        next = { kind: 'run', iterations: request.iterations ?? args.defaultIterations };
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
      const work = next;
      if (work.kind === 'plan') {
        save({ status: 'planning', batch: null });
        logger.info('daemon planning the project', { id: work.request.id, mode: work.request.mode });
        try {
          await args.runPlan!(work.request, stopping);
        } catch (cause) {
          logger.error('planning failed', { error: cause instanceof Error ? cause.message : String(cause) });
        }
        next = undefined;
        if (stopping.aborted) break;
        save({ status: 'idle' });
        logger.info('daemon idle');
        continue;
      }
      const { iterations } = work;
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
