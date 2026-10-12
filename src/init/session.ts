import { resolve } from 'node:path';
import { RALPH_DIR } from '../config/load.js';
import { scaffold } from './scaffold.js';
import { planState } from './plan.js';
import { runInterview, type InterviewOutcome } from './interview.js';
import { commitPlan, snapshotTasks, type PlanCommit, type TaskSnapshot } from './commit.js';
import type { PlanMode, RecordingIO } from './record.js';
import type { AskRelay } from '../loop/asks.js';
import type { AgentHarness } from '../harness/types.js';
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
 * now (the scaffold may have just written it). Returns it with the files the
 * scaffold created or updated, which the plan's commit takes. Throws with
 * what to tell the owner when the interview cannot go ahead in `mode`.
 */
export function preparePlan(projectRoot: string, reload: () => Config, mode: PlanMode): { config: Config; scaffolded: string[] } {
  const result = scaffold(projectRoot);
  if (result.status === 'legacy') throw new Error(result.message);
  const config = reload();
  const problem = planningProblem(config);
  if (problem) throw new Error(problem);
  const written = planState(config.projectRoot, config.ralphDir) === 'written';
  if (mode === 'new' && written) throw new Error(`A plan already exists in ${RALPH_DIR}/: revise it instead`);
  if (mode === 'replan' && !written) throw new Error('There is no plan to revise yet: plan the project first');
  return { config, scaffolded: [...result.created, ...result.updated] };
}

/** How a session ended, and the plan's commit when there was one to make. */
export type PlanOutcome = InterviewOutcome & { commit?: PlanCommit };

/**
 * Hold the interview through `io`, keeping each turn's events and the outcome
 * with its record. A plan that passes validation is committed with the
 * session's journal, unless `git.records` is `never`.
 */
export async function planWith(args: {
  harness: AgentHarness;
  config: Config;
  logger: Logger;
  io: RecordingIO;
  signal: AbortSignal;
  replan: boolean;
  templatesDir?: string;
  /** How the agent's forms and asked permissions reach the owner. */
  asks?: AskRelay;
  /** Files the scaffold created or updated for this session, committed with the plan. */
  scaffolded?: readonly string[];
}): Promise<PlanOutcome> {
  const { config, io } = args;
  const { recorder } = io;
  recorder.update({ model: config.plan.model ?? config.model ?? null, maxTurns: config.plan.maxTurns });
  // A new plan replaces the template's example task, which is no task of the plan's.
  const before: TaskSnapshot = args.replan ? snapshotTasks(config.projectRoot, config.ralphDir) : new Map();
  let outcome: InterviewOutcome;
  try {
    outcome = await runInterview({
      harness: args.harness,
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
  } catch (cause) {
    recorder.fail(cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }
  if (outcome.status !== 'planned' || config.git.records === 'never') return outcome;

  const commit = await commitPlan({
    projectRoot: config.projectRoot,
    ralphDir: config.ralphDir,
    planId: recorder.id,
    mode: args.replan ? 'replan' : 'new',
    ...(outcome.request !== undefined ? { request: outcome.request } : {}),
    before,
    ...(args.scaffolded ? { scaffolded: args.scaffolded } : {}),
  });
  if (!commit) return outcome;
  if (commit.error) args.logger.warn('could not commit the plan', { plan: recorder.id, error: commit.error });
  else if (commit.committed) args.logger.info('committed the plan', { plan: recorder.id, subject: commit.subject });
  return { ...outcome, commit };
}
