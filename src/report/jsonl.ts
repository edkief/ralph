import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpencodeEvent } from '../opencode/events.js';
import type { IterationResult } from '../loop/iteration.js';
import type { ProgressDelta } from '../loop/progress.js';
import type { IterationStatus } from '../loop/outcome.js';
import type { LogEntry } from './logger.js';
import { UsageMeter, type TurnUsage } from '../metrics/usage.js';

export interface IterationRecord {
  iteration: number;
  taskId: string | null;
  result: IterationResult;
  delta: ProgressDelta;
  /** Who wrote the handoff when the iteration ran out of time or context. */
  handoff?: 'agent' | 'fallback';
  /**
   * The iteration's usage by model, every attempt, wrap-up and subagent
   * included. Absent from records written before it was metered.
   */
  models?: TurnUsage;
  startedAt: string;
  endedAt: string;
}

/**
 * A split turn the loop ran for a task that kept running out of time or
 * context, or the assessment of a task before its first attempt.
 */
export interface SplitRecord {
  /** The iteration after which the task stalled, or the one the assessment came before. */
  iteration: number;
  taskId: string;
  /** What each attempt at the task ran out of; none for an assessment. */
  causes: string[];
  /** What led to the turn. Absent from records written before tasks were assessed, all stalls. */
  trigger?: 'stall' | 'assessment';
  /** The working time the agent estimated, for an assessment that gave an estimate. */
  estimateMinutes?: number;
  /**
   * `applied` and `proposed` name the new tasks; `declined` and `failed` give
   * the reason, as does `retry`, after which the task was attempted again as
   * it is. `fits` is an assessment that found the task small enough.
   */
  status: 'proposed' | 'applied' | 'declined' | 'retry' | 'failed' | 'fits';
  children?: string[];
  reason?: string;
  committed?: boolean;
  /**
   * The turn's usage by model; for a split that carried on from an
   * assessment, the assessment's too. Absent from records written before it was metered.
   */
  models?: TurnUsage;
  startedAt: string;
  endedAt: string;
}

/**
 * A turn of the escalation agent, which got a request before a person did.
 * `resolved` settled it with `action`; `escalated` passed it on, and `failed`
 * gave no answer, so a person was asked. `reason` is the agent's note or
 * analysis, or why the turn failed.
 */
export interface EscalationRecord {
  /** The run's escalation turns are numbered from 1. */
  n: number;
  /** The iteration the request came after. */
  iteration: number;
  kind: string;
  taskId: string | null;
  status: 'resolved' | 'escalated' | 'failed';
  action?: string;
  reason?: string;
  models?: TurnUsage;
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
   * The split turn in progress, or with `phase: 'assess'` the assessment of a
   * task before its first attempt. Stays set once that turn ends, until the next
   * iteration starts, so a run that stops on a proposal still names its last
   * session. Absent from runs recorded before split turns were tracked.
   */
  split?: { taskId: string; startedAt: string; phase?: 'assess' | 'split' } | null;
  /**
   * The escalation turn in progress, or the last one, until the next
   * iteration starts. Its record in `escalations.jsonl` says it ended.
   */
  escalation?: { n: number; kind: string; taskId: string | null; startedAt: string } | null;
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
  /** The usage of the turn in progress, written with its record. */
  private readonly meter = new UsageMeter();

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
    this.meter.reset();
  }

  /** Events from here on belong to the split turn for `taskId`. */
  beginSplit(taskId: string): void {
    this.current = resolve(this.dir, `split-${taskId}.events.jsonl`);
    writeFileSync(this.current, '');
    this.meter.reset();
  }

  /** Record a split turn or assessment, with the usage of the turn since it began. */
  recordSplit(record: SplitRecord): void {
    const entry: SplitRecord = { ...record, models: this.meter.drain() };
    appendFileSync(resolve(this.dir, 'splits.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  /** Events from here on belong to escalation turn `n`. */
  beginEscalation(n: number): void {
    this.current = resolve(this.dir, `escalation-${n}.events.jsonl`);
    writeFileSync(this.current, '');
    this.meter.reset();
  }

  /** Record an escalation turn, with its usage since it began. */
  recordEscalation(record: EscalationRecord): void {
    const entry: EscalationRecord = { ...record, models: this.meter.drain() };
    appendFileSync(resolve(this.dir, 'escalations.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  recordEvent(event: OpencodeEvent): void {
    if (!this.current) return;
    appendFileSync(this.current, `${JSON.stringify(event)}\n`);
    this.meter.push(event, Date.now());
  }

  /** Record an iteration, with its usage since it began. */
  recordIteration(record: IterationRecord): void {
    const entry: IterationRecord = { ...record, models: this.meter.drain() };
    appendFileSync(resolve(this.dir, 'iterations.jsonl'), `${JSON.stringify(entry)}\n`);
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
