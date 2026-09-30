import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { runIteration, type IterationResult } from './iteration.js';
import { ensureHandoff, handoffDir, handoffPath, readHandoff } from './handoff.js';
import { diffSnapshots, snapshotRepo } from './progress.js';
import { pushBranch } from './push.js';
import { TERMINAL_STATUSES, type IterationStatus } from './outcome.js';
import { TaskStore } from '../tasks/store.js';
import { buildPrompt } from '../prompt/build.js';
import { buildWrapUpPrompt } from '../prompt/wrapup.js';
import { sleep } from '../opencode/server.js';
import { RunRecorder, newRunId } from '../report/jsonl.js';
import { truncate } from '../report/console.js';
import type { ConsoleReporter } from '../report/console.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

export interface RunResult {
  status: IterationStatus | 'max-iterations' | 'stalled' | 'stopped';
  iterations: number;
  runId: string;
  historyDir: string;
  tasksPassed: number;
  tasksTotal: number;
  message: string;
}

/**
 * Drive iterations until the backlog is done, the agent needs a human, the
 * budget runs out, or progress stops.
 *
 * Unlike the previous loop, an iteration's claimed outcome is cross-checked
 * against the repository: a `TASK-x:DONE` tag with no commit and no flipped
 * `passes` flag counts as no progress, and repeated no-progress iterations
 * stop the run instead of burning the whole budget.
 *
 * An iteration that runs out of time leaves a handoff for the next attempt at
 * its task, and a task that keeps running out of time stops the run.
 *
 * Aborting `signal` interrupts the iteration in flight. Aborting `stop` lets
 * it finish, then ends the run before the next one, still pushing its commits.
 */
export async function runLoop(args: {
  config: Config;
  client: OpencodeClient;
  logger: Logger;
  reporter: ConsoleReporter;
  signal: AbortSignal;
  stop?: AbortSignal;
}): Promise<RunResult> {
  const { config, client, logger, reporter, signal } = args;
  const stop = args.stop ?? new AbortController().signal;
  // Waits between iterations end early for either request.
  const pause = AbortSignal.any([signal, stop]);
  const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir);
  const runId = newRunId();
  const recorder = new RunRecorder(
    resolve(config.projectRoot, config.ralphDir, 'history'),
    runId,
  );

  let unproductive = 0;
  const timeoutsByTask = new Map<string, number>();
  // Handoff notes are how a task resumes, not progress on it.
  const notProgress = [handoffDir(config.ralphDir)];
  // Commits the loop has not yet published. A failed push leaves this set,
  // so the next push attempt (or the one at run end) catches up.
  let unpushed = false;
  let iteration = 0;
  let finalStatus: RunResult['status'] = 'max-iterations';
  let message = `Reached the ${config.maxIterations} iteration budget with work outstanding`;

  for (iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    if (signal.aborted) {
      finalStatus = 'interrupted';
      message = 'Interrupted';
      break;
    }

    const summary = tasks.reload();
    if (!summary.next) {
      finalStatus = 'complete';
      message = `All ${summary.total} tasks pass`;
      iteration -= 1;
      break;
    }

    if (stop.aborted) {
      finalStatus = 'stopped';
      message = `Stopped on request after ${iteration - 1} iteration${iteration === 2 ? '' : 's'}`;
      iteration -= 1;
      break;
    }

    const next = summary.next;
    const taskId = next.id;
    const handoffFile = handoffPath(config.projectRoot, config.ralphDir, taskId);
    reporter.iterationStart(iteration, config.maxIterations, taskId);
    recorder.beginIteration(iteration);

    const before = await snapshotRepo(config.projectRoot, tasks, notProgress);
    const startedAt = new Date().toISOString();

    const { result, timeouts, handoff } = await attemptIteration({
      args: { client, config, logger, reporter, signal, stop },
      recorder,
      iteration,
      // Built per attempt, so a retry sees the handoff the failed one left.
      prompt: () => {
        const text = readHandoff(handoffFile);
        return buildPrompt({
          projectRoot: config.projectRoot,
          ralphDir: config.ralphDir,
          iteration,
          maxIterations: config.maxIterations,
          nextTask: next,
          pinTask: config.pinTask,
          timeBudget: {
            ms: config.timeouts.iterationMs,
            until: new Date(Date.now() + config.timeouts.iterationMs),
          },
          ...(text ? { handoff: { path: handoffFile, text } } : {}),
        });
      },
      taskId,
      handoffFile,
      sinceHead: before.head,
      timeoutsLeft: config.stall.maxTimeoutsPerTask - (timeoutsByTask.get(taskId) ?? 0),
    });
    if (timeouts > 0) timeoutsByTask.set(taskId, (timeoutsByTask.get(taskId) ?? 0) + timeouts);

    const after = await snapshotRepo(config.projectRoot, tasks, notProgress);
    const delta = diffSnapshots(before, after);
    const status = refineStatus(result, delta);

    if (result.tags.completedTaskIds.length > 0 && delta.tasksPassedDelta <= 0) {
      logger.warn('agent claimed a task without marking it passing', {
        claimed: result.tags.completedTaskIds.join(','),
      });
    }

    reporter.iterationEnd(result, delta, status);
    recorder.recordIteration({
      iteration,
      taskId,
      result,
      delta,
      ...(handoff ? { handoff } : {}),
      startedAt,
      endedAt: new Date().toISOString(),
    });

    if (delta.tasksPassedDelta > 0 && existsSync(handoffFile) && taskPasses(tasks, taskId)) {
      logger.warn('handoff left behind for a passing task', { path: display(config, handoffFile) });
    }

    if (delta.committed) unpushed = true;
    if (config.git.push === 'iteration' && unpushed) {
      unpushed = !(await publish(config, logger, { iteration }));
    }

    if (TERMINAL_STATUSES.has(status)) {
      finalStatus = status;
      message = terminalMessage(status, result);
      break;
    }

    const timedOut = timeoutsByTask.get(taskId) ?? 0;
    if (timedOut >= config.stall.maxTimeoutsPerTask) {
      finalStatus = 'stalled';
      message = `${taskId} ran out of time ${timedOut} time${timedOut === 1 ? '' : 's'}; split it into smaller tasks (handoff: ${display(config, handoffFile)})`;
      break;
    }

    unproductive = delta.productive ? 0 : unproductive + 1;
    if (unproductive >= config.stall.maxUnproductiveIterations) {
      finalStatus = 'stalled';
      message = `${unproductive} iterations in a row changed nothing (last: ${status}${
        result.error ? ` — ${result.error}` : ''
      })`;
      break;
    }

    if (status === 'provider-error') {
      logger.warn('provider unhealthy, backing off', {
        error: result.lastProviderError ?? 'unknown',
        backoffMs: config.retries.backoffMs,
      });
      await sleep(config.retries.backoffMs, pause);
    } else if (config.pauseBetweenIterationsMs > 0) {
      await sleep(config.pauseBetweenIterationsMs, pause);
    }
  }

  if (config.git.push !== 'never' && unpushed && !signal.aborted) {
    await publish(config, logger, {});
  }

  const finalSummary = tasks.reload();

  // The budget may run out on an iteration that finished the backlog; judge
  // the run by the task list, not by which loop exit was taken.
  if (finalStatus === 'max-iterations' && !finalSummary.next && finalSummary.total > 0) {
    finalStatus = 'complete';
    message = `All ${finalSummary.total} tasks pass`;
  }

  const runResult: RunResult = {
    status: finalStatus,
    iterations: Math.min(iteration, config.maxIterations),
    runId,
    historyDir: recorder.directory,
    tasksPassed: finalSummary.passedCount,
    tasksTotal: finalSummary.total,
    message,
  };
  recorder.recordSummary(runResult);
  return runResult;
}

/**
 * Run an iteration, retrying the whole turn when the provider failed or the
 * agent timed out — those say nothing about the task, only about the runtime.
 * An attempt that runs out of time leaves a handoff, and is not retried when
 * the agent wrapped up: the next iteration resumes from its handoff instead.
 */
async function attemptIteration(context: {
  args: {
    client: OpencodeClient;
    config: Config;
    logger: Logger;
    reporter: ConsoleReporter;
    signal: AbortSignal;
    stop: AbortSignal;
  };
  recorder: RunRecorder;
  iteration: number;
  prompt: () => string;
  taskId: string;
  handoffFile: string;
  sinceHead: string | null;
  /** Attempts that may still run out of time before the task is given up on. */
  timeoutsLeft: number;
}): Promise<{ result: IterationResult; timeouts: number; handoff?: 'agent' | 'fallback' }> {
  const { client, config, logger, reporter, signal, stop } = context.args;
  const handoffShown = display(config, context.handoffFile);
  let attempt = 0;
  let timeouts = 0;
  let result: IterationResult;
  let handoff: 'agent' | 'fallback' | undefined;

  for (;;) {
    const since = Date.now();
    result = await runIteration({
      client,
      config,
      logger,
      signal,
      prompt: context.prompt(),
      title: `ralph ${context.iteration} · ${context.taskId}`,
      ...(config.timeouts.wrapUpMs > 0
        ? {
            wrapUp: {
              prompt: (trigger) =>
                buildWrapUpPrompt({
                  taskId: context.taskId,
                  handoffPath: handoffShown,
                  trigger,
                  wrapUpMs: config.timeouts.wrapUpMs,
                }),
            },
          }
        : {}),
      hooks: {
        onEvent: (event) => context.recorder.recordEvent(event),
        onText: (text) => reporter.status(truncate(text, 100)),
        onTool: (tool, detail) => reporter.status(`${tool} ${detail}`),
        onRetry: (attemptNumber, error) =>
          reporter.status(`provider retry ${attemptNumber}: ${truncate(error, 70)}`),
      },
    });

    handoff = undefined;
    if (result.status === 'wrapped-up' || result.status === 'timeout') {
      timeouts += 1;
      handoff = await ensureHandoff({
        path: context.handoffFile,
        projectRoot: config.projectRoot,
        taskId: context.taskId,
        iteration: context.iteration,
        since,
        sinceHead: context.sinceHead,
        reason: result.error ?? result.status,
        agentText: result.text,
      });
      logger.info(handoff === 'agent' ? 'agent left a handoff' : 'agent left no handoff; wrote one from what the loop saw', {
        path: handoffShown,
      });
    }

    const done = { result, timeouts, ...(handoff ? { handoff } : {}) };
    const retryable = result.status === 'provider-error' || result.status === 'timeout';
    // A retry is a fresh turn, which a stop request rules out.
    if (
      !retryable ||
      attempt >= config.retries.iterationRetries ||
      timeouts >= context.timeoutsLeft ||
      signal.aborted ||
      stop.aborted
    ) {
      return done;
    }

    attempt += 1;
    logger.warn('retrying iteration', {
      iteration: context.iteration,
      attempt,
      reason: result.status,
      ...(result.error ? { detail: result.error } : {}),
    });
    await sleep(config.retries.backoffMs, AbortSignal.any([signal, stop]));
    if (stop.aborted) return done;
  }
}

function taskPasses(tasks: TaskStore, taskId: string): boolean {
  return tasks.readTasks().some((task) => task.id === taskId && task.passes);
}

/** A path as the agent and the user see it: relative to the project, with forward slashes. */
function display(config: Config, path: string): string {
  return relative(config.projectRoot, path).split(sep).join('/');
}

/** Push the branch, logging the outcome. A failed push never stops the run. */
async function publish(
  config: Config,
  logger: Logger,
  context: { iteration?: number },
): Promise<boolean> {
  const { remote, pushTimeoutMs } = config.git;
  const result = await pushBranch(config.projectRoot, remote, pushTimeoutMs);
  if (result.ok) {
    logger.info('pushed commits', { remote, ...context });
  } else {
    logger.warn('push failed', { remote, ...context, error: result.error });
  }
  return result.ok;
}

/** An iteration that ran cleanly but changed nothing is not progress. */
function refineStatus(result: IterationResult, delta: { productive: boolean }): IterationStatus {
  if (result.status === 'progressed' && !delta.productive) return 'no-progress';
  return result.status;
}

function terminalMessage(status: IterationStatus, result: IterationResult): string {
  switch (status) {
    case 'complete':
      return 'Agent reported the backlog is complete';
    case 'blocked':
      return result.tags.blockedReason ?? 'Agent is blocked';
    case 'decide':
      return result.tags.decideQuestion ?? 'Agent needs a decision';
    case 'interrupted':
      return 'Interrupted';
    default:
      return status;
  }
}
