import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpencodeEvent } from '../opencode/events.js';
import type { IterationResult } from '../loop/iteration.js';
import type { ProgressDelta } from '../loop/progress.js';

export interface IterationRecord {
  iteration: number;
  taskId: string | null;
  result: IterationResult;
  delta: ProgressDelta;
  startedAt: string;
  endedAt: string;
}

/**
 * Persists what each iteration did under `.agent/history/<runId>/`:
 * the raw event stream for debugging, and a compact record per iteration.
 * Replaces the old ANSI-stripped terminal transcripts, which were unparseable.
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

  recordEvent(event: OpencodeEvent): void {
    if (!this.current) return;
    appendFileSync(this.current, `${JSON.stringify(event)}\n`);
  }

  recordIteration(record: IterationRecord): void {
    appendFileSync(resolve(this.dir, 'iterations.jsonl'), `${JSON.stringify(record)}\n`);
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
