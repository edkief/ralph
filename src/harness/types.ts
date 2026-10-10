import type { Config } from '../config/schema.js';
import type { HarnessEvent } from './events.js';

/**
 * Which optional behaviours a harness has. The loop branches on these, never
 * on a harness's name. They are plain data, fixed when the harness started.
 */
export interface HarnessCapabilities {
  /**
   * A prompt sent to a busy session reaches the agent at its next step,
   * without stopping the tool that is running; without this, a prompt to a
   * busy session waits until the whole turn ends. The wrap-up steers when it
   * can, and interrupts first when it cannot.
   */
  readonly steering: boolean;
  /** The agent can open forms (a question tool, an MCP server's request for input) that wait on `replyForm` or `cancelForm`. */
  readonly forms: boolean;
  /** The agent can raise permission requests that wait on `replyPermission`. */
  readonly permissionAsks: boolean;
  /** The agent can start child sessions: `parentOf` is meaningful, and the loop attributes their work to the turn. */
  readonly subagents: boolean;
  /** The harness has a skills registry for preflight to check. */
  readonly skills: boolean;
}

export interface PromptOptions {
  model?: string;
  agent?: string;
  /** Only with `capabilities.steering`. */
  delivery?: 'steer';
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Warnings do not stop the run. */
  fatal: boolean;
}

/**
 * What an agent turn needs from the harness that runs the agent. The loop,
 * the planner, assess, confirm, escalation and split all drive this and
 * nothing else.
 */
export interface AgentHarness {
  /** For logs and banners. Callers never branch on it. */
  readonly name: string;
  readonly capabilities: HarnessCapabilities;

  /**
   * The harness's own environment checks (it is up, its API is the one Ralph
   * speaks, its model, its skills), run after the project's own.
   */
  preflight(config: Config): Promise<CheckResult[]>;

  /** Open a session and return its id. */
  createSession(title: string): Promise<string>;

  /**
   * Subscribe to the harness's events.
   *
   * Resolves only once the subscription is live, and callers await it before
   * the first `prompt`: an async generator does no work until its first
   * `next()`, so a subscription opened lazily would start only after the
   * prompt had been sent and let early events slip through the gap.
   */
  connectEvents(signal: AbortSignal): Promise<AsyncGenerator<HarnessEvent>>;

  /**
   * Queue a prompt. Returns as soon as the harness accepts it: completion is
   * observed on the event stream, not here.
   */
  prompt(sessionId: string, text: string, options?: PromptOptions): Promise<void>;

  /** Stop the session's running turn. */
  interrupt(sessionId: string): Promise<void>;

  replyPermission(sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;

  /** Answer a form, by field key. A refusal with status 400 says the answer does not fit the form. */
  replyForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void>;

  /** Cancel a form waiting on an answer. Its asker gets `message` as the reason. */
  cancelForm(sessionId: string, formId: string, message: string): Promise<void>;

  /**
   * The parent of a session, to attribute a subagent's work to the turn.
   * Called only with `capabilities.subagents`.
   */
  parentOf(sessionId: string): Promise<string | undefined>;

  /** Stop what Ralph started; nothing when it attached to something already running. */
  stop(): Promise<void>;
}

/**
 * A harness refused a request. `status` keeps the meaning of an HTTP status
 * whatever the transport: 404 the thing is gone, 409 it is already settled,
 * 400 the answer does not fit, any other 4xx is final, and a 5xx may be
 * retried.
 */
export class HarnessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}
