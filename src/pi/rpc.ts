import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { FrameSchema, ResponseSchema, type PiFrame, type PiResponse } from './frames.js';
import { HarnessApiError } from '../harness/types.js';
import type { Logger } from '../report/logger.js';
import { keepWithParent, stopChild } from '../util/process-guard.js';

export interface PiProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  /** Time a stopping process gets to end on its own before it is killed. */
  shutdownTimeoutMs: number;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

export interface PiExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The end of what the process wrote on stderr. */
  stderr: string;
}

/** pi answered a command with `success: false`; or never answered because it exited. */
export class PiCommandError extends HarnessApiError {}

const STDERR_TAIL = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * One `pi --mode rpc` child: JSONL over stdin and stdout. Commands go in with an `id`, and the
 * `response` with that `id` answers them; every other line is an event for `onFrame`.
 *
 * The child is tied to this process (see `keepWithParent`), so it ends with Ralph however Ralph ends.
 */
export class PiProcess {
  private readonly pending = new Map<string, { type: string; resolve: (response: PiResponse) => void; reject: (cause: Error) => void; timer: NodeJS.Timeout }>();
  private readonly frameHandlers = new Set<(frame: PiFrame) => void>();
  private readonly exitHandlers = new Set<(exit: PiExit) => void>();
  private stderr = '';
  private nextId = 1;
  private ended: PiExit | undefined;

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: PiProcessOptions,
  ) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    // Records end at LF only: U+2028 and U+2029 are legal inside JSON strings, so no line reader that splits on them.
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.stdin?.on('error', () => undefined);
    child.once('error', (cause) => this.finish({ code: null, signal: null, stderr: `${cause.message}\n${this.stderr}`.trim() }));
    child.once('exit', (code, signal) => this.finish({ code, signal, stderr: this.stderr.trim() }));
  }

  static spawn(options: PiProcessOptions): PiProcess {
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    keepWithParent(child, options.shutdownTimeoutMs);
    return new PiProcess(child, options);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exit(): PiExit | undefined {
    return this.ended;
  }

  onFrame(handler: (frame: PiFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onExit(handler: (exit: PiExit) => void): void {
    if (this.ended) handler(this.ended);
    else this.exitHandlers.add(handler);
  }

  /** Write a line pi expects no answer to (an `extension_ui_response`). */
  write(value: Record<string, unknown>): void {
    if (this.ended || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /**
   * Send a command and wait for its answer. Rejects with a `PiCommandError` (status 400) when pi answers
   * `success: false`, and (status 503) when pi exits first or does not answer in time.
   */
  request(command: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PiResponse> {
    const type = String(command['type']);
    if (this.ended) return Promise.reject(this.exited(type));
    const id = `ralph-${this.nextId++}`;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiCommandError(`pi did not answer ${type} within ${timeoutMs}ms`, 503, ''));
      }, timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** End the process: close its stdin, which it exits on, then stop it if it will not. */
  async stop(): Promise<void> {
    if (this.ended) return;
    this.child.stdin?.end();
    const exited = once(this.child, 'exit').catch(() => undefined);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, Math.min(1_000, this.options.shutdownTimeoutMs)))]);
    await stopChild(this.child, this.options.shutdownTimeoutMs);
  }

  private receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.options.logger.debug('pi wrote a line that is not JSON', { line: line.slice(0, 200) });
      return;
    }
    const frame = FrameSchema.safeParse(value);
    if (!frame.success) return;

    if (frame.data.type === 'response') {
      const response = ResponseSchema.safeParse(frame.data);
      const id = response.success ? response.data.id : undefined;
      const waiting = id ? this.pending.get(id) : undefined;
      if (!response.success || !id || !waiting) return;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      if (response.data.success) waiting.resolve(response.data);
      else waiting.reject(new PiCommandError(response.data.error ?? `pi refused ${response.data.command ?? 'the command'}`, 400, response.data.error ?? ''));
      return;
    }
    for (const handler of this.frameHandlers) handler(frame.data);
  }

  private exited(command: string): PiCommandError {
    const exit = this.ended;
    const how = exit?.signal ? `signal ${exit.signal}` : `code ${exit?.code ?? 'unknown'}`;
    return new PiCommandError(`pi exited (${how}) before it answered ${command}${exit?.stderr ? `: ${exit.stderr}` : ''}`, 503, exit?.stderr ?? '');
  }

  private finish(exit: PiExit): void {
    if (this.ended) return;
    this.ended = exit;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(this.exited(waiting.type));
      this.pending.delete(id);
    }
    for (const handler of this.exitHandlers) handler(exit);
    this.exitHandlers.clear();
  }
}
