import { resolve } from 'node:path';
import { RALPH_DIR } from '../config/load.js';
import { scaffold } from './scaffold.js';
import { planState } from './plan.js';
import { runInterview, type InterviewOutcome } from './interview.js';
import type { PlanMode, RecordingIO } from './record.js';
import type { AskRelay } from '../loop/asks.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

/**
 * A planning session, whoever holds it: `ralph init` in a terminal, or a
 * daemon for the web UI. Only how the owner is reached differs.
 */

/** Why the agent cannot plan under this configuration, if it cannot. */
export function planningProblem(config: Config): string | undefined {
  if (resolve(config.projectRoot, config.ralphDir) === resolve(config.projectRoot, RALPH_DIR)) return undefined;
  return `ralphDir is set to ${config.ralphDir}, but init plans in ${RALPH_DIR}/. Unset ralphDir to plan with the agent.`;
}

/**
 * Get a project ready for an interview asked for from afar: scaffold it as
 * `ralph init` does, never overwriting, then read the configuration as it is
 * now (the scaffold may have just written it). Throws with what to tell the
 * owner when the interview cannot go ahead in `mode`.
 */
export function preparePlan(projectRoot: string, reload: () => Config, mode: PlanMode): Config {
  const scaffolded = scaffold(projectRoot);
  if (scaffolded.status === 'legacy') throw new Error(scaffolded.message);
  const config = reload();
  const problem = planningProblem(config);
  if (problem) throw new Error(problem);
  const written = planState(config.projectRoot, config.ralphDir) === 'written';
  if (mode === 'new' && written) throw new Error(`A plan already exists in ${RALPH_DIR}/: revise it instead`);
  if (mode === 'replan' && !written) throw new Error('There is no plan to revise yet: plan the project first');
  return config;
}

/** Hold the interview through `io`, keeping each turn's events and the outcome with its record. */
export async function planWith(args: {
  client: OpencodeClient;
  config: Config;
  logger: Logger;
  io: RecordingIO;
  signal: AbortSignal;
  replan: boolean;
  templatesDir?: string;
  /** How the agent's forms and asked permissions reach the owner. */
  asks?: AskRelay;
}): Promise<InterviewOutcome> {
  const { config, io } = args;
  const { recorder } = io;
  recorder.update({ model: config.plan.model ?? config.model ?? null, maxTurns: config.plan.maxTurns });
  try {
    const outcome = await runInterview({
      client: args.client,
      config,
      logger: args.logger,
      io,
      signal: args.signal,
      replan: args.replan,
      ...(args.templatesDir ? { templatesDir: args.templatesDir } : {}),
      onEvent: (event) => recorder.recordEvent(event),
      ...(args.asks ? { asks: args.asks } : {}),
    });
    recorder.finish(outcome);
    return outcome;
  } catch (cause) {
    recorder.fail(cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }
}
