const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;
export type LogFormat = 'text' | 'json';

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[2m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  stream?: NodeJS.WritableStream;
  color?: boolean;
}

/**
 * Minimal leveled logger. Text for humans at a terminal, JSON lines for k8s
 * log collectors. Everything goes to stderr so stdout stays free for the
 * loop's own reporting.
 */
export class Logger {
  private readonly level: number;
  private readonly format: LogFormat;
  private readonly stream: NodeJS.WritableStream;
  private readonly color: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = LEVELS[options.level ?? 'info'];
    this.format = options.format ?? 'text';
    this.stream = options.stream ?? process.stderr;
    this.color = options.color ?? Boolean((this.stream as NodeJS.WriteStream).isTTY);
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

    if (this.format === 'json') {
      this.stream.write(
        `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`,
      );
      return;
    }

    const prefix = this.color ? `${COLORS[level]}${level}\x1b[0m` : level;
    const extra = fields && Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : '';
    this.stream.write(`${prefix} ${message}${extra}\n`);
  }
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}
