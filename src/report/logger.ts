import { formatClock } from './time.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;
export type LogFormat = 'text' | 'json';

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[2m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

/** One log line as a sink receives it: UTC time, whatever the output format. */
export interface LogEntry {
  time: string;
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  stream?: NodeJS.WritableStream;
  color?: boolean;
  now?: () => Date;
}

/** Lines kept while held. */
const MAX_HELD = 2000;

/**
 * Minimal leveled logger. Text for humans at a terminal, stamped with the
 * local time; JSON lines with UTC ISO times for k8s log collectors.
 * Everything goes to stderr so stdout stays free for the loop's own reporting.
 */
export class Logger {
  private readonly level: number;
  private readonly format: LogFormat;
  private readonly stream: NodeJS.WritableStream;
  private readonly color: boolean;
  private readonly now: () => Date;
  private hook: (() => void) | undefined;
  private held: string[] | null = null;
  private readonly sinks = new Set<(entry: LogEntry) => void>();

  constructor(options: LoggerOptions = {}) {
    this.level = LEVELS[options.level ?? 'info'];
    this.format = options.format ?? 'text';
    this.stream = options.stream ?? process.stderr;
    this.color = options.color ?? Boolean((this.stream as NodeJS.WriteStream).isTTY);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Run `hook` before each line is written, e.g. to clear a transient status
   * line on the same terminal so the log line does not land on the end of it.
   */
  beforeWrite(hook: (() => void) | undefined): void {
    this.hook = hook;
  }

  /**
   * Also hand every line that passes the level to `sink`, e.g. to keep a
   * run's log on disk. Returns a function that detaches it.
   */
  addSink(sink: (entry: LogEntry) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /**
   * Keep lines off the stream until `release`, e.g. while a menu is on the
   * terminal. Sinks still get every line as it is logged.
   */
  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const held = this.held;
    this.held = null;
    for (const line of held ?? []) this.stream.write(line);
  }

  private emit(line: string): void {
    if (!this.held) this.stream.write(line);
    else if (this.held.length < MAX_HELD) this.held.push(line);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.level) return;
    if (!this.held) this.hook?.();
    const now = this.now();
    for (const sink of this.sinks) {
      sink({ time: now.toISOString(), level, message, ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) });
    }

    if (this.format === 'json') {
      this.emit(`${JSON.stringify({ time: now.toISOString(), level, message, ...fields })}\n`);
      return;
    }

    const clock = this.color ? `${COLORS.debug}${formatClock(now)}\x1b[0m` : formatClock(now);
    const prefix = this.color ? `${COLORS[level]}${level}\x1b[0m` : level;
    const extra = fields && Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : '';
    this.emit(`${clock} ${prefix} ${message}${extra}\n`);
  }
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}
