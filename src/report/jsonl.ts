import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpencodeEvent } from '../opencode/events.js';
import type { IterationResult } from '../loop/iteration.js';
import type { ProgressDelta } from '../loop/progress.js';
import type { IterationStatus } from '../loop/outcome.js';
import type { LogEntry } from './logger.js';

export interface IterationRecord {
  iteration: number;
  taskId: string | null;
  result: IterationResult;
  delta: ProgressDelta;
  /** Who wrote the handoff when the iteration ran out of time or context. */
  handoff?: 'agent' | 'fallback';
  startedAt: string;
  endedAt: string;
}

/** A split turn the loop ran for a task that kept running out of time or context. */
export interface SplitRecord {
  /** The iteration after which the task stalled. */
  iteration: number;
  taskId: string;
  /** What each attempt at the task ran out of. */
  causes: string[];
  /** `applied` and `proposed` name the new tasks; `declined` and `failed` give the reason. */
  status: 'proposed' | 'applied' | 'declined' | 'failed';
  children?: string[];
  reason?: string;
  committed?: boolean;
  startedAt: string;
  endedAt: string;
}

/**
 * Where a run stands, rewritten as it moves so a reader (the web UI) can
 * follow a run in progress; `run.json` only appears once it is over.
 */
export interface RunState {
  runId: string;
  /** `running`, or `waiting` for a person, until the run ends; then its final status. */
  status: string;
  pid: number;
  /** Where `pid` lives; a reader on another host cannot check it. */
  hostname: string;
  startedAt: string;
  updatedAt: string;
  maxIterations: number;
  /** The iteration in progress, or the last one once the run has ended. 0 before the first. */
  iteration: number;
  taskId: string | null;
  iterationStartedAt: string | null;
  /** Outcome of the last finished iteration. */
  lastStatus: IterationStatus | null;
  tasksPassed: number;
  tasksTotal: number;
  /**
   * The split turn in progress. Stays set once that turn ends, until the next
   * iteration starts, so a run that stops on a proposal still names its last
   * session. Absent from runs recorded before split turns were tracked.
   */
  split?: { taskId: string; startedAt: string } | null;
  /** What the run is waiting on a person for, while it is `waiting`. */
  pending?: { id: string; kind: string; taskId: string | null } | null;
  message?: string;
}

/**
 * Persists what each iteration did under `<ralphDir>/history/<runId>/`:
 * the raw event stream for debugging, and a compact record per iteration.
 * Replaces the old ANSI-stripped terminal transcripts, which were unparseable.
 * Also keeps the run's log lines and its live state, for the web UI.
 */
export class RunRecorder {
  private readonly dir: string;
  private current: string | null = null;

  constructor(historyRoot: string, readonly runId: string) {
    this.dir = resolve(historyRoot, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  get directory(): string {
    return this.dir;
  }

  beginIteration(iteration: number): void {
    this.current = resolve(this.dir, `iteration-${String(iteration).padStart(3, '0')}.events.jsonl`);
    writeFileSync(this.current, '');
  }

  /** Events from here on belong to the split turn for `taskId`. */
  beginSplit(taskId: string): void {
    this.current = resolve(this.dir, `split-${taskId}.events.jsonl`);
    writeFileSync(this.current, '');
  }

  recordSplit(record: SplitRecord): void {
    appendFileSync(resolve(this.dir, 'splits.jsonl'), `${JSON.stringify(record)}\n`);
  }

  recordEvent(event: OpencodeEvent): void {
    if (!this.current) return;
    appendFileSync(this.current, `${JSON.stringify(event)}\n`);
  }

  recordIteration(record: IterationRecord): void {
    appendFileSync(resolve(this.dir, 'iterations.jsonl'), `${JSON.stringify(record)}\n`);
  }

  recordLog(entry: LogEntry): void {
    appendFileSync(resolve(this.dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  /** Replace `state.json` in one step, so a reader never sees half of it. */
  recordState(state: RunState): void {
    const file = resolve(this.dir, 'state.json');
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  recordSummary(summary: unknown): void {
    writeFileSync(resolve(this.dir, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

export function newRunId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}
