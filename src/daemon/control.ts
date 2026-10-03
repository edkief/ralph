import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readAs, writeAtomic } from '../human/request.js';

/**
 * How a daemon and whoever steers it talk: the daemon keeps where it stands
 * in `history/daemon.json`, and takes requests to run a batch or to shut down
 * from `history/daemon-request.json`. Files, as for stop and respond, so the
 * web UI or `ralph daemon run` may be another process or container that shares
 * only the Ralph folder. Pausing a batch is the stop request a run already takes.
 */

export const DAEMON_STATUSES = ['idle', 'running', 'stopping', 'stopped'] as const;
export type DaemonStatus = (typeof DAEMON_STATUSES)[number];

const DaemonStateSchema = z.object({
  pid: z.number().int(),
  /** Where `pid` lives; a reader on another host cannot check it. */
  hostname: z.string(),
  startedAt: z.string(),
  /** Rewritten every few seconds while the daemon is up. */
  updatedAt: z.string(),
  /** `idle` between batches, `running` a batch, `stopping` on its way out, `stopped` once gone. */
  status: z.enum(DAEMON_STATUSES),
  /** Iterations a run request without a number gets. */
  defaultIterations: z.number().int().positive(),
  /** The batch in progress, while `running`. */
  batch: z.object({ iterations: z.number().int().positive(), startedAt: z.string() }).nullable(),
  /** How the last batch ended: its run's status, or `failed` when it never got going (e.g. preflight). */
  lastBatch: z.object({ status: z.string(), message: z.string(), endedAt: z.string() }).nullable().optional(),
  uiUrl: z.string().optional(),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

const DaemonRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), iterations: z.number().int().positive().max(10_000).optional() }),
  z.object({ kind: z.literal('shutdown') }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;

export const daemonPath = (ralphRoot: string) => resolve(ralphRoot, 'history', 'daemon.json');
export const daemonRequestPath = (ralphRoot: string) => resolve(ralphRoot, 'history', 'daemon-request.json');
export const daemonLogPath = (ralphRoot: string) => resolve(ralphRoot, 'history', 'daemon.log');

/**
 * A daemon on another host whose heartbeat is older than this is taken to
 * have died. It writes one every few seconds, whatever it is doing.
 */
export const DAEMON_STALE_MS = 60_000;

export function writeDaemonState(ralphRoot: string, state: DaemonState): void {
  writeAtomic(daemonPath(ralphRoot), state);
}

export function readDaemonState(ralphRoot: string): DaemonState | undefined {
  return readAs(daemonPath(ralphRoot), DaemonStateSchema);
}

/** Whether the daemon that wrote `state` is still up. */
export function daemonLive(state: DaemonState, now: number = Date.now()): boolean {
  if (state.status === 'stopped') return false;
  if (state.hostname === hostname()) {
    try {
      process.kill(state.pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  return now - Date.parse(state.updatedAt) < DAEMON_STALE_MS;
}

/** The project's daemon, if one is up. */
export function liveDaemon(ralphRoot: string): DaemonState | undefined {
  const state = readDaemonState(ralphRoot);
  return state && daemonLive(state) ? state : undefined;
}

export function writeDaemonRequest(ralphRoot: string, request: DaemonRequest, by: 'ui' | 'cli'): void {
  writeAtomic(daemonRequestPath(ralphRoot), { ...request, by, requestedAt: new Date().toISOString() });
}

export function readDaemonRequest(ralphRoot: string): DaemonRequest | undefined {
  return readAs(daemonRequestPath(ralphRoot), DaemonRequestSchema);
}

export function clearDaemonRequest(ralphRoot: string): void {
  rmSync(daemonRequestPath(ralphRoot), { force: true });
}

export class DaemonRequestError extends Error {}

/**
 * Ask the project's daemon to run a batch. Refused when no daemon is up, or
 * when it is busy with one already: a pause, then a run, gives a fresh budget.
 */
export function requestRun(ralphRoot: string, iterations: number | undefined, by: 'ui' | 'cli'): DaemonState {
  const state = liveDaemon(ralphRoot);
  if (!state) throw new DaemonRequestError('No daemon is running for this project: start one with `ralph daemon`');
  if (state.status !== 'idle') {
    throw new DaemonRequestError('The daemon is already running a batch: pause it first, or wait for it to end');
  }
  writeDaemonRequest(ralphRoot, { kind: 'run', ...(iterations !== undefined ? { iterations } : {}) }, by);
  return state;
}

/** Ask the project's daemon to stop whatever it runs and exit. */
export function requestShutdown(ralphRoot: string, by: 'ui' | 'cli'): DaemonState {
  const state = liveDaemon(ralphRoot);
  if (!state) throw new DaemonRequestError('No daemon is running for this project');
  writeDaemonRequest(ralphRoot, { kind: 'shutdown' }, by);
  return state;
}
