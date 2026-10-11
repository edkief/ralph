import type { Config } from '../../src/config/schema.js';
import type { HarnessEvent } from '../../src/harness/events.js';
import type { AgentHarness, CheckResult, HarnessCapabilities, PromptOptions } from '../../src/harness/types.js';
import type { OpencodeFrame } from '../../src/opencode/frames.js';
import { OpencodeTranslator } from '../../src/opencode/translate.js';

export const SESSION = 'ses_fake';

/**
 * A frame for a session, as opencode sends it. The fake harness scripts frames
 * and runs them through the opencode translator, so the loop is tested on what
 * a real adapter emits, and the scripts read like the captures they come from.
 */
export function event(type: string, sessionID: string, data: Record<string, unknown> = {}): OpencodeFrame {
  return { type, data: { sessionID, ...data } };
}

export interface FakeHarnessOptions {
  capabilities?: Partial<HarnessCapabilities>;
  /** Frames the harness emits when the Nth prompt (1-based) arrives. */
  script: (promptCount: number) => OpencodeFrame[];
  /** How long connecting takes, so a subscription opened late would miss what a prompt triggers. */
  connectMs?: number;
  /** Fail permission replies with this error. */
  replyPermissionError?: Error;
}

/**
 * A harness with no transport: the loop is driven through the interface alone.
 * Frames emitted while no subscription is live are dropped, as a stream
 * opened too late would drop them.
 */
export class FakeHarness implements AgentHarness {
  readonly name = 'fake';
  readonly capabilities: HarnessCapabilities;
  /** What the loop called, in order, e.g. `connected`, `createSession`, `prompt`. */
  readonly calls: string[] = [];
  readonly prompts: Array<{ sessionId: string; text: string; options: PromptOptions }> = [];
  readonly interrupted: string[] = [];
  readonly permissionReplies: Array<{ sessionId: string; requestId: string; reply: string; reason?: string }> = [];
  readonly parentLookups: string[] = [];
  preflightCalls = 0;

  private live: ((frame: OpencodeFrame) => void) | undefined;

  constructor(private readonly options: FakeHarnessOptions) {
    this.capabilities = {
      steering: false,
      forms: true,
      permissionAsks: true,
      subagents: false,
      skills: false,
      ...options.capabilities,
    };
  }

  async preflight(_config: Config): Promise<CheckResult[]> {
    this.preflightCalls += 1;
    return [{ name: 'fake', ok: true, detail: 'ready', fatal: true }];
  }

  async createSession(_title: string): Promise<string> {
    this.calls.push('createSession');
    return SESSION;
  }

  async connectEvents(signal: AbortSignal): Promise<AsyncGenerator<HarnessEvent>> {
    this.calls.push('connect');
    await new Promise((resolve) => setTimeout(resolve, this.options.connectMs ?? 0));
    this.calls.push('connected');
    const queue: HarnessEvent[] = [];
    const translator = new OpencodeTranslator();
    let wake: (() => void) | undefined;
    this.live = (frame) => {
      queue.push(...translator.push(frame));
      wake?.();
    };
    signal.addEventListener('abort', () => wake?.(), { once: true });
    const self = this;
    return (async function* () {
      try {
        while (!signal.aborted) {
          const next = queue.shift();
          if (next) yield next;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        self.live = undefined;
      }
    })();
  }

  async prompt(sessionId: string, text: string, options: PromptOptions = {}): Promise<void> {
    this.calls.push('prompt');
    this.prompts.push({ sessionId, text, options });
    const events = this.options.script(this.prompts.length);
    // After the prompt returns, as a real agent would answer it.
    setTimeout(() => events.forEach((frame) => this.live?.(frame)), 5);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.calls.push('interrupt');
    this.interrupted.push(sessionId);
    this.live?.(event('session.execution.aborted', sessionId));
  }

  async replyPermission(sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject', reason?: string): Promise<void> {
    this.calls.push('replyPermission');
    if (this.options.replyPermissionError) throw this.options.replyPermissionError;
    this.permissionReplies.push({ sessionId, requestId, reply, ...(reason ? { reason } : {}) });
  }

  async replyForm(): Promise<void> {
    this.calls.push('replyForm');
  }

  async cancelForm(): Promise<void> {
    this.calls.push('cancelForm');
  }

  async parentOf(sessionId: string): Promise<string | undefined> {
    this.parentLookups.push(sessionId);
    return sessionId === 'ses_child' ? SESSION : undefined;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }
}
