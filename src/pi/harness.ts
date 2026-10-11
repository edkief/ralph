import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config, PiConfig } from '../config/schema.js';
import type { HarnessEvent } from '../harness/events.js';
import { HarnessApiError, type AgentHarness, type CheckResult, type HarnessCapabilities, type PromptOptions } from '../harness/types.js';
import type { Logger } from '../report/logger.js';
import { EventBus } from './bus.js';
import { piChecks } from './preflight.js';
import { PiCommandError, PiProcess } from './rpc.js';
import { PiSession } from './session.js';

/** Time pi gets to start and say who it is. */
const STARTUP_TIMEOUT_MS = 60_000;
/** Time a stopping pi gets before it is killed. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
/** How long a session may be quiet before its process is stopped; a later prompt starts a new one. */
export const IDLE_MS = 60_000;

export interface PiHarnessOptions {
  /** Where pi runs: the project root. */
  cwd: string;
  logger: Logger;
  /** See `IDLE_MS`. */
  idleMs?: number;
  /** See `END_GRACE_MS` in translate.ts. */
  graceMs?: number;
  /** See `RERUN_WAIT_MS` in translate.ts. */
  rerunWaitMs?: number;
}

/**
 * pi behind the harness interface. pi's RPC mode drives one session per process, so each session Ralph opens
 * has a process of its own (assess and escalation turns, which run beside the loop's, included). The sessions
 * share an event bus, and their files live under `<ralph dir>/history/pi/`, which is how a session whose
 * process was stopped (idle, or lost) is continued: a new process `switch_session`s onto the file.
 */
export class PiHarness implements AgentHarness {
  readonly name = 'pi';
  readonly capabilities: HarnessCapabilities = {
    // A steered prompt waits for the tool that is running, then reaches the model before its next call.
    steering: true,
    // Permissions and questions are what a pi extension supplies (#80); until then there are none.
    forms: false,
    permissionAsks: false,
    // pi has no subagents.
    subagents: false,
    skills: true,
  };

  private readonly bus = new EventBus();
  private readonly sessions = new Map<string, PiSession>();
  /** Sessions being brought back, so a second prompt does not start a second process. */
  private readonly reviving = new Map<string, Promise<PiSession>>();
  private readonly sessionDir: string;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly options: PiHarnessOptions,
  ) {
    this.sessionDir = resolve(config.projectRoot, config.ralphDir, 'history', 'pi');
  }

  preflight(config: Config): Promise<CheckResult[]> {
    return piChecks(config, { cwd: this.options.cwd, logger: this.options.logger });
  }

  async createSession(title: string): Promise<string> {
    const session = await this.open();
    this.sessions.set(session.id, session);
    // A name for pi's own listings; the session works without it.
    void session.name(title).catch(() => undefined);
    this.bus.publish({ type: 'session.started', created: Date.now(), session: session.id });
    return session.id;
  }

  async connectEvents(signal: AbortSignal): Promise<AsyncGenerator<HarnessEvent>> {
    return this.bus.subscribe(signal);
  }

  async prompt(sessionId: string, text: string, options: PromptOptions = {}): Promise<void> {
    const session = await this.session(sessionId);
    await session.prompt(text, options);
  }

  async interrupt(sessionId: string): Promise<void> {
    // A session whose process was stopped has nothing running.
    const session = this.sessions.get(sessionId);
    if (session?.alive) await session.interrupt();
  }

  async replyPermission(): Promise<void> {
    throw new HarnessApiError('pi asks no permissions', 404, '');
  }

  async replyForm(): Promise<void> {
    throw new HarnessApiError('pi opens no forms', 404, '');
  }

  async cancelForm(): Promise<void> {
    throw new HarnessApiError('pi opens no forms', 404, '');
  }

  async parentOf(): Promise<string | undefined> {
    return undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((session) => session.stop().catch(() => undefined)));
  }

  /** The live session, starting its process again when it was stopped. */
  private async session(id: string): Promise<PiSession> {
    const live = this.sessions.get(id);
    if (live?.alive) return live;
    const reviving = this.reviving.get(id) ?? this.revive(id);
    this.reviving.set(id, reviving);
    try {
      return await reviving;
    } finally {
      this.reviving.delete(id);
    }
  }

  private async revive(id: string): Promise<PiSession> {
    const file = this.fileOf(id);
    if (!file) throw new HarnessApiError(`pi has no session ${id}: no file for it in ${this.sessionDir}`, 404, '');
    const session = await this.open(file);
    this.sessions.set(id, session);
    this.options.logger.info('continued a pi session in a new process', { session: id });
    return session;
  }

  /** Where pi wrote the session, named `<time>_<id>.jsonl`. */
  private fileOf(id: string): string | undefined {
    try {
      const name = readdirSync(this.sessionDir).find((entry) => entry.endsWith(`_${id}.jsonl`));
      return name ? resolve(this.sessionDir, name) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Start a pi process, on a session file already written (`resume`) or a new one. */
  private async open(resume?: string): Promise<PiSession> {
    if (this.stopped) throw new HarnessApiError('the pi harness is stopped', 503, '');
    mkdirSync(this.sessionDir, { recursive: true });
    const process = PiProcess.spawn({
      binary: this.config.pi.binary,
      args: piArguments(this.config.pi, this.sessionDir),
      cwd: this.options.cwd,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      logger: this.options.logger,
    });
    try {
      if (resume) {
        const switched = await process.request({ type: 'switch_session', sessionPath: resume }, STARTUP_TIMEOUT_MS);
        if ((switched.data as { cancelled?: boolean } | undefined)?.cancelled) {
          throw new HarnessApiError('pi would not switch to the session', 409, '');
        }
      }
      const state = await readState(process);
      return new PiSession(state.sessionId, state.sessionFile, state.model, process, {
        logger: this.options.logger,
        publish: (event) => this.bus.publish(event),
        onLost: (lost) => {
          if (this.sessions.get(lost.id) === lost) this.sessions.delete(lost.id);
        },
        onIdle: (idle) => {
          this.options.logger.debug('stopping the process of a quiet pi session', { session: idle.id });
          if (this.sessions.get(idle.id) === idle) this.sessions.delete(idle.id);
          void idle.stop();
        },
        idleMs: this.options.idleMs ?? IDLE_MS,
        ...(this.options.graceMs !== undefined ? { graceMs: this.options.graceMs } : {}),
        ...(this.options.rerunWaitMs !== undefined ? { rerunWaitMs: this.options.rerunWaitMs } : {}),
      });
    } catch (cause) {
      await process.stop().catch(() => undefined);
      throw cause;
    }
  }
}

/** The command line of a session's pi process. */
export function piArguments(pi: PiConfig, sessionDir: string): string[] {
  return ['--mode', 'rpc', '--session-dir', sessionDir, ...(pi.thinking ? ['--thinking', pi.thinking] : []), ...pi.args];
}

async function readState(process: PiProcess): Promise<{ sessionId: string; sessionFile: string; model: string | undefined }> {
  const response = await process.request({ type: 'get_state' }, STARTUP_TIMEOUT_MS);
  const data = (response.data ?? {}) as { sessionId?: string; sessionFile?: string; model?: { provider?: string; id?: string } | null };
  if (!data.sessionId || !data.sessionFile) {
    throw new PiCommandError('pi reported no session id', 502, JSON.stringify(response.data ?? null));
  }
  const model = data.model?.provider && data.model.id ? `${data.model.provider}/${data.model.id}` : data.model?.id;
  return { sessionId: data.sessionId, sessionFile: data.sessionFile, model };
}
