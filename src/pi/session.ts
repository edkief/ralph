import type { HarnessEvent } from '../harness/events.js';
import type { PromptOptions } from '../harness/types.js';
import { HarnessApiError } from '../harness/types.js';
import type { Logger } from '../report/logger.js';
import { UiRequestSchema, type PiFrame } from './frames.js';
import type { PiExit, PiProcess } from './rpc.js';
import { PiTranslator } from './translate.js';

/** Dialogs a pi extension can open; each waits for an `extension_ui_response`. */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

/** The longest a prompt waits for a compaction under way to end. */
const COMPACTION_WAIT_MS = 120_000;

export interface SessionOptions {
  logger: Logger;
  publish: (event: HarnessEvent) => void;
  /** Called when the process ended without being asked to. */
  onLost: (session: PiSession, exit: PiExit) => void;
  /** Called when the session has been quiet for `idleMs`. */
  onIdle: (session: PiSession) => void;
  idleMs: number;
  graceMs?: number;
  rerunWaitMs?: number;
}

/**
 * A live pi session: its process, and the translation of what the process says into events. The harness
 * keeps one per active session, and stops the process once the session has been quiet for a while; the
 * session's file is what lets a later prompt pick it up again.
 */
export class PiSession {
  private readonly translator: PiTranslator;
  private settleTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private compactionWaiters: Array<() => void> = [];
  private stopping = false;

  constructor(
    readonly id: string,
    readonly file: string,
    /** `provider/id`, or nothing when pi has no model. */
    public model: string | undefined,
    private readonly process: PiProcess,
    private readonly options: SessionOptions,
  ) {
    this.translator = new PiTranslator(id, {
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.rerunWaitMs !== undefined ? { rerunWaitMs: options.rerunWaitMs } : {}),
    });
    process.onFrame((frame) => this.receive(frame));
    process.onExit((exit) => this.lost(exit));
    this.armIdle();
  }

  get running(): boolean {
    return this.translator.running;
  }

  get alive(): boolean {
    return this.process.exit === undefined;
  }

  /**
   * Send the agent a prompt. To a busy session, a steered prompt reaches the agent at its next step and a
   * plain one waits for the turn to end; to an idle one, there is nothing to steer, and a steer would only
   * wait in pi's queue for the next prompt.
   */
  async prompt(text: string, options: PromptOptions): Promise<void> {
    this.cancelIdle();
    await this.compactionIdle();
    if (!this.running && options.model && options.model !== this.model) await this.setModel(options.model);
    if (this.running) {
      await this.process.request(
        options.delivery === 'steer'
          ? { type: 'steer', message: text }
          : { type: 'prompt', message: text, streamingBehavior: 'followUp' },
      );
      return;
    }
    // Before the request: the first event of the run may be read before its answer is.
    this.translator.markStarting();
    try {
      await this.process.request({ type: 'prompt', message: text });
    } catch (cause) {
      // Nothing started, and nothing is to be reported of it: the caller has the error.
      this.translator.settle();
      this.armIdle();
      throw cause;
    }
  }

  /** Name the session in pi's listings. */
  async name(title: string): Promise<void> {
    await this.process.request({ type: 'set_session_name', name: title });
  }

  /** Stop the running turn. */
  async interrupt(): Promise<void> {
    this.translator.markStopping();
    await this.process.request({ type: 'abort' });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelIdle();
    clearTimeout(this.settleTimer);
    await this.process.stop();
  }

  /** Leave the quiet-session timer alone while a turn is under way. */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.stopping || this.options.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.running || this.translator.compacting) return this.armIdle();
      this.options.onIdle(this);
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private cancelIdle(): void {
    clearTimeout(this.idleTimer);
  }

  private async setModel(model: string): Promise<void> {
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) {
      throw new HarnessApiError(`Model must be "provider/model", got "${model}"`, 400, '');
    }
    await this.process.request({ type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    this.model = model;
  }

  /** Resolves once no compaction is under way: a prompt sent into one would run on a context that is about to change. */
  private compactionIdle(): Promise<void> {
    if (!this.translator.compacting) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, COMPACTION_WAIT_MS);
      this.compactionWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private receive(frame: PiFrame): void {
    if (frame.type === 'extension_ui_request') this.answerDialog(frame);
    this.publishAll(this.translator.push(frame));
    if (frame.type === 'compaction_end') {
      const waiters = this.compactionWaiters;
      this.compactionWaiters = [];
      for (const wake of waiters) wake();
    }
    this.armSettle();
  }

  /** Nobody is there to answer an extension's dialog, and the tool or command that opened it waits on one. */
  private answerDialog(frame: PiFrame): void {
    const request = UiRequestSchema.safeParse(frame).data;
    if (!request || !DIALOG_METHODS.has(request.method)) return;
    this.options.logger.warn('a pi extension asked a question; it is cancelled, as nobody can answer during a turn', {
      method: request.method,
      title: typeof frame['title'] === 'string' ? frame['title'] : undefined,
    });
    this.process.write({ type: 'extension_ui_response', id: request.id, cancelled: true });
  }

  private armSettle(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    const delay = this.translator.settleDelay();
    if (delay !== undefined) {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = undefined;
        this.publishAll(this.translator.settle());
        this.armIdle();
      }, delay);
    }
    if (!this.translator.running) this.armIdle();
  }

  private lost(exit: PiExit): void {
    clearTimeout(this.settleTimer);
    this.cancelIdle();
    const wasRunning = this.running;
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`;
    this.publishAll(this.translator.exited(`pi exited (${how})${exit.stderr ? `: ${exit.stderr}` : ''}`));
    for (const wake of this.compactionWaiters.splice(0)) wake();
    if (!this.stopping) {
      this.options.logger.warn(wasRunning ? 'pi exited during a turn' : 'pi exited', { session: this.id, code: exit.code, signal: exit.signal });
      this.options.onLost(this, exit);
    }
  }

  private publishAll(events: HarnessEvent[]): void {
    for (const event of events) this.options.publish(event);
  }
}
