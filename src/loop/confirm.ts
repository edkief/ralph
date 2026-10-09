import { existsSync, rmSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { runIteration, type IterationHooks, type IterationResult } from './iteration.js';
import { ensureHandoff } from './handoff.js';
import { buildConfirmPrompt } from '../prompt/confirm.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { TaskStore } from '../tasks/store.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

export interface ConfirmOutcome {
  /** `confirmed`: the task stays passing. `reopened`: it is marked failing again, for the next iteration. */
  verdict: 'confirmed' | 'reopened';
  /** Why the task's state was in doubt. */
  doubt: string;
  /** Why it was reopened, when it was. */
  reason?: string;
  /** The confirm turn, when one ran. */
  turn?: IterationResult;
}

/**
 * Why a task the attempt left passing may not be done, if anything says so:
 * the attempt was cut short, and the wrap-up told the agent the task was not
 * done and not to mark it passing.
 */
export function passingInDoubt(result: IterationResult): string | undefined {
  if (result.wrapUp?.trigger === 'park') return 'the run was parked before the attempt finished';
  if (result.wrapUp?.trigger === 'inactivity' || result.trip === 'inactivity') return 'the attempt went quiet and was cut short';
  if (result.status === 'context-overflow') return "the attempt outgrew the model's context window";
  if (result.wrapUp || result.status === 'wrapped-up' || result.status === 'timeout') return 'the attempt ran out of time';
  return undefined;
}

/**
 * Settle a task the attempt left marked passing while it was cut short, which
 * says it may not be done. A short turn, in the attempt's session when it is still
 * usable, checks the task without working on it: the agent's DONE confirms
 * it, and the stale handoff goes. Anything else (no tag, a failed or
 * timed-out turn, a stop request, a turn turned off) reopens it: `passes` goes
 * back to false and the handoff stays, so the next iteration resumes the task
 * rather than moving on with it half done.
 *
 * A task that passes after an attempt that finished is not in doubt: a
 * handoff an earlier attempt left for it is stale, and is removed. Returns
 * nothing then.
 */
export async function settlePassing(args: {
  client: OpencodeClient;
  config: Config;
  logger: Logger;
  signal: AbortSignal;
  /** A stop or park request: no turn, the task is reopened. */
  stopped: boolean;
  tasks: TaskStore;
  iteration: number;
  taskId: string;
  specFilePath?: string | undefined;
  handoffFile: string;
  /** HEAD when the iteration started, for a handoff Ralph has to write. */
  sinceHead: string | null;
  /** How the attempt ended. */
  result: IterationResult;
  hooks?: IterationHooks;
  onStart?: () => void;
}): Promise<ConfirmOutcome | undefined> {
  const { config, logger, tasks, taskId, handoffFile, result } = args;
  if (args.signal.aborted || !tasks.isPassing(taskId)) return undefined;
  const shown = (path: string) => relative(config.projectRoot, path).split(sep).join('/');
  const doubt = passingInDoubt(result);
  if (!doubt) {
    if (existsSync(handoffFile)) {
      rmSync(handoffFile);
      logger.info('removed the handoff left for a task that now passes', { task: taskId, path: shown(handoffFile) });
    }
    return undefined;
  }

  let turn: IterationResult | undefined;
  let reason: string | undefined;
  const since = Date.now();
  if (args.stopped) {
    reason = 'the run is stopping, so there was no turn to confirm it';
  } else if (config.timeouts.confirmMs === 0) {
    reason = 'confirming is turned off (timeouts.confirmMs is 0)';
  } else {
    args.onStart?.();
    logger.info('the task is marked passing, but in doubt; asking the agent to confirm it', { task: taskId, doubt });
    // A conversation that outgrew the context window has no room left for this one.
    const sameSession = result.sessionId !== '' && result.status !== 'context-overflow';
    try {
      turn = await runIteration({
        client: args.client,
        config,
        logger,
        signal: args.signal,
        prompt: buildConfirmPrompt({
          taskId,
          specFilePath: args.specFilePath,
          handoffPath: shown(handoffFile),
          tasksPath: shown(tasks.path),
          reason: doubt,
          confirmMs: config.timeouts.confirmMs,
        }),
        title: `ralph ${args.iteration} · ${taskId} · confirm`,
        ...(sameSession ? { sessionId: result.sessionId } : {}),
        iterationMs: config.timeouts.confirmMs,
        ...(args.hooks ? { hooks: args.hooks } : {}),
      });
    } catch (cause) {
      reason = `the confirm turn failed: ${(cause as Error).message}`;
    }
    if (turn) {
      const said = turn.tags.completedTaskIds.includes(taskId);
      const settled = turn.status === 'progressed' || turn.status === 'complete';
      if (said && settled && tasks.isPassing(taskId)) {
        if (existsSync(handoffFile)) rmSync(handoffFile);
        logger.info('the agent confirmed the task is done', { task: taskId });
        return { verdict: 'confirmed', doubt, turn };
      }
      if (turn.tags.blockedReason || turn.tags.decideQuestion) {
        logger.warn('ignoring a promise tag raised in the confirm turn', {
          task: taskId,
          ...(turn.tags.blockedReason ? { blocked: turn.tags.blockedReason } : {}),
          ...(turn.tags.decideQuestion ? { decide: turn.tags.decideQuestion } : {}),
        });
      }
      reason = !settled
        ? `the confirm turn ended ${turn.status}${turn.error ? ` (${turn.error})` : ''}`
        : said
          ? `the agent confirmed it but left it failing`
          : 'the agent did not confirm it';
    }
  }

  if (args.signal.aborted) return undefined;
  if (tasks.isPassing(taskId)) tasks.setPasses(taskId, false);
  await ensureHandoff({
    path: handoffFile,
    projectRoot: config.projectRoot,
    taskId,
    iteration: args.iteration,
    since,
    sinceHead: args.sinceHead,
    reason: `${doubt}, and the task was reopened: ${reason}`,
    cutShortBy:
      result.wrapUp?.trigger === 'park' ? 'park' : result.status === 'context-overflow' ? 'context' : 'time',
    agentText: [result.text, turn?.text ?? ''].filter(Boolean).join('\n'),
  });
  logger.warn('reopened a task marked passing that was not confirmed done', { task: taskId, doubt, reason: reason ?? '' });
  return { verdict: 'reopened', doubt, ...(reason ? { reason } : {}), ...(turn ? { turn } : {}) };
}

/**
 * The attempt and its confirm turn as one result: what the agent did adds up,
 * how the attempt ended stands, unless the task was confirmed done.
 */
export function withConfirm(result: IterationResult, outcome: ConfirmOutcome): IterationResult {
  const turn = outcome.turn;
  const usage = { ...result.usage };
  if (turn) for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += turn.usage[key];
  return {
    ...result,
    ...(outcome.verdict === 'confirmed' ? { status: 'progressed' as const } : {}),
    ...(turn
      ? {
          text: [result.text, turn.text].filter(Boolean).join('\n'),
          usage,
          toolCalls: result.toolCalls + turn.toolCalls,
          filesTouched: [...new Set([...result.filesTouched, ...turn.filesTouched])],
          providerRetries: result.providerRetries + turn.providerRetries,
          compactions: result.compactions + turn.compactions,
          durationMs: result.durationMs + turn.durationMs,
        }
      : {}),
  };
}
