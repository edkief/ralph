import type { ServerConfig, Config } from '../config/schema.js';
import type { HarnessEvent } from '../harness/events.js';
import type { AgentHarness, CheckResult, HarnessCapabilities, PromptOptions } from '../harness/types.js';
import type { Logger } from '../report/logger.js';
import type { OpencodeClient } from './client.js';
import { harnessChecks } from './preflight.js';
import { startServer } from './server.js';

/**
 * opencode behind the harness interface: the HTTP client for the calls, and
 * the server Ralph spawned (if it did) for stopping.
 */
export class OpencodeHarness implements AgentHarness {
  readonly name = 'opencode';

  private constructor(
    private readonly client: OpencodeClient,
    private readonly stopServer: () => Promise<void>,
    readonly capabilities: HarnessCapabilities,
  ) {}

  /**
   * Wrap a client whose server is up. Whether it takes steered prompts depends
   * on the server's version, so the live spec is read once, here.
   */
  static async connect(client: OpencodeClient, stop: () => Promise<void> = async () => undefined): Promise<OpencodeHarness> {
    const steering = await client.supportsSteering();
    return new OpencodeHarness(client, stop, { steering, forms: true, permissionAsks: true, subagents: true, skills: true });
  }

  preflight(config: Config): Promise<CheckResult[]> {
    return harnessChecks(this.client, config);
  }

  createSession(title: string): Promise<string> {
    return this.client.createSession(title);
  }

  connectEvents(signal: AbortSignal): Promise<AsyncGenerator<HarnessEvent>> {
    return this.client.connectEvents(signal);
  }

  prompt(sessionId: string, text: string, options: PromptOptions = {}): Promise<void> {
    return this.client.prompt(sessionId, text, options);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.client.interrupt(sessionId);
  }

  replyPermission(sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    return this.client.replyPermission(sessionId, requestId, reply);
  }

  replyForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void> {
    return this.client.replyForm(sessionId, formId, answer);
  }

  cancelForm(sessionId: string, formId: string, message: string): Promise<void> {
    return this.client.cancelForm(sessionId, formId, message);
  }

  async parentOf(sessionId: string): Promise<string | undefined> {
    return (await this.client.getSession(sessionId)).parentID;
  }

  stop(): Promise<void> {
    return this.stopServer();
  }
}

/** Attach to the opencode server `config.url` names, or spawn one Ralph owns. */
export async function startOpencode(
  config: ServerConfig,
  options: { cwd: string; logger: Logger },
): Promise<OpencodeHarness> {
  const server = await startServer(config, options);
  try {
    return await OpencodeHarness.connect(server.client, server.stop);
  } catch (cause) {
    await server.stop();
    throw cause;
  }
}
