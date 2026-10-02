import type { IterationResult } from '../loop/iteration.js';
import type { ProgressDelta } from '../loop/progress.js';
import type { IterationStatus } from '../loop/outcome.js';
import { formatClock, formatDay } from './time.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
} as const;

const STATUS_ICON: Record<IterationStatus, string> = {
  progressed: '✓',
  'no-progress': '·',
  complete: '🎉',
  blocked: '⛔',
  decide: '❓',
  'provider-error': '⚡',
  timeout: '⏱',
  'wrapped-up': '⏸',
  'context-overflow': '⧉',
  failed: '✗',
  interrupted: '■',
};

/** Pieces of output kept while held; more than a menu left open should gather. */
const MAX_HELD = 2000;

/**
 * Human-facing progress output on stdout.
 *
 * Detects a TTY: interactive terminals get an in-place status line, while
 * pipes and container logs get one durable line per event so nothing is lost
 * to carriage returns. Every line but the banner starts with the local time,
 * and a date line marks an iteration that begins on a new day.
 */
export class ConsoleReporter {
  private readonly tty: boolean;
  private statusActive = false;
  private day: string;
  private held: string[] | null = null;

  constructor(
    private readonly stream: NodeJS.WriteStream = process.stdout,
    color?: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.tty = color ?? Boolean(stream.isTTY);
    this.day = formatDay(this.now());
  }

  /**
   * Keep output off the terminal, e.g. while a menu is on it. Durable lines
   * are kept for `release`; the transient status line is just dropped.
   */
  hold(): void {
    this.clearStatus();
    this.held ??= [];
  }

  release(): void {
    const held = this.held;
    this.held = null;
    for (const text of held ?? []) this.stream.write(text);
  }

  private write(text: string): void {
    if (!this.held) this.stream.write(text);
    else if (this.held.length < MAX_HELD) this.held.push(text);
  }

  banner(lines: string[]): void {
    this.write(`\n${lines.map((line) => this.paint(line, C.cyan)).join('\n')}\n\n`);
  }

  iterationStart(iteration: number, max: number, taskId: string | null): void {
    const now = this.now();
    const day = formatDay(now);
    if (day !== this.day) {
      this.day = day;
      this.write(`\n${this.paint(`── ${day} ──`, C.dim)}\n`);
    }
    const task = taskId ? ` ${this.paint(`→ ${taskId}`, C.yellow)}` : '';
    this.write(
      `\n${this.paint(formatClock(now), C.dim)} ${this.paint(`Iteration ${iteration}/${max}`, C.bold)}${task}\n`,
    );
  }

  /** Transient activity line: overwritten on a TTY, appended elsewhere. */
  status(text: string): void {
    const line = `${formatClock(this.now())}   ${truncate(text, 100)}`;
    if (!this.tty) {
      this.write(`${line}\n`);
      return;
    }
    if (this.held) return;
    this.write(`\r\x1b[2K${this.paint(line, C.dim)}`);
    this.statusActive = true;
  }

  clearStatus(): void {
    if (this.tty && this.statusActive) {
      this.write('\r\x1b[2K');
      this.statusActive = false;
    }
  }

  iterationEnd(result: IterationResult, delta: ProgressDelta, status: IterationStatus): void {
    this.clearStatus();
    const icon = STATUS_ICON[status];
    const parts = [
      `${formatDuration(result.durationMs)}`,
      `${result.toolCalls} tools`,
      `${result.usage.input + result.usage.output} tok`,
    ];
    if (delta.committed) parts.push('committed');
    if (delta.tasksPassedDelta > 0) parts.push(`+${delta.tasksPassedDelta} task`);
    if (result.providerRetries > 0) parts.push(`${result.providerRetries} retries`);
    if (result.compactions > 0) parts.push(`compacted ×${result.compactions}`);

    const stamp = this.stamp();
    this.write(`${stamp}   ${icon} ${status} ${this.paint(`· ${parts.join(' · ')}`, C.dim)}\n`);
    if (result.error) this.write(`${stamp}   ${this.paint(result.error, C.yellow)}\n`);
  }

  summary(title: string, lines: string[], tone: 'good' | 'warn' | 'bad' = 'good'): void {
    this.clearStatus();
    const color = tone === 'good' ? C.green : tone === 'warn' ? C.yellow : C.red;
    this.write(`\n${this.stamp()} ${this.paint(title, color)}\n`);
    for (const line of lines) this.write(`  ${line}\n`);
    this.write('\n');
  }

  private stamp(): string {
    return this.paint(formatClock(this.now()), C.dim);
  }

  private paint(text: string, color: string): string {
    return this.tty ? `${color}${text}${C.reset}` : text;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
