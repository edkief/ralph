import { resolve } from 'node:path';
import { runIteration, type IterationResult } from './iteration.js';
import { diffSnapshots, snapshotRepo } from './progress.js';
import { TERMINAL_STATUSES, type IterationStatus } from './outcome.js';
import { TaskStore } from '../tasks/store.js';
import { buildPrompt } from '../prompt/build.js';
import { sleep } from '../opencode/server.js';
import { RunRecorder, newRunId } from '../report/jsonl.js';
import { truncate } from '../report/console.js';
import type { ConsoleReporter } from '../report/console.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

export interface RunResult {
  status: IterationStatus | 'max-iterations' | 'stalled';
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
 */
export async function runLoop(args: {
  config: Config;
  client: OpencodeClient;
  logger: Logger;
  reporter: ConsoleReporter;
  signal: AbortSignal;
}): Promise<RunResult> {
  const { config, client, logger, reporter, signal } = args;
  const tasks = TaskStore.forProject(config.projectRoot, config.agentDir);
  const runId = newRunId();
  const recorder = new RunRecorder(
    resolve(config.projectRoot, config.agentDir, 'history'),
    runId,
  );

  let unproductive = 0;
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

    const taskId = summary.next.id;
    reporter.iterationStart(iteration, config.maxIterations, taskId);
    recorder.beginIteration(iteration);

    const before = await snapshotRepo(config.projectRoot, tasks);
    const startedAt = new Date().toISOString();

    const result = await attemptIteration({
      args: { client, config, logger, reporter, signal },
      recorder,
      iteration,
      prompt: buildPrompt({
        projectRoot: config.projectRoot,
        agentDir: config.agentDir,
        iteration,
        maxIterations: config.maxIterations,
        nextTask: summary.next,
        pinTask: config.pinTask,
      }),
      taskId,
    });

    const after = await snapshotRepo(config.projectRoot, tasks);
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
      startedAt,
      endedAt: new Date().toISOString(),
    });

    if (TERMINAL_STATUSES.has(status)) {
      finalStatus = status;
      message = terminalMessage(status, result);
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
      await sleep(config.retries.backoffMs, signal);
    } else if (config.pauseBetweenIterationsMs > 0) {
      await sleep(config.pauseBetweenIterationsMs, signal);
    }
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
 */
async function attemptIteration(context: {
  args: {
    client: OpencodeClient;
    config: Config;
    logger: Logger;
    reporter: ConsoleReporter;
    signal: AbortSignal;
  };
  recorder: RunRecorder;
  iteration: number;
  prompt: string;
  taskId: string;
}): Promise<IterationResult> {
  const { client, config, logger, reporter, signal } = context.args;
  let attempt = 0;
  let result: IterationResult;

  for (;;) {
    result = await runIteration({
      client,
      config,
      logger,
      signal,
      prompt: context.prompt,
      title: `ralph ${context.iteration} · ${context.taskId}`,
      hooks: {
        onEvent: (event) => context.recorder.recordEvent(event),
        onText: (text) => reporter.status(truncate(text, 100)),
        onTool: (tool, detail) => reporter.status(`${tool} ${detail}`),
        onRetry: (attemptNumber, error) =>
          reporter.status(`provider retry ${attemptNumber}: ${truncate(error, 70)}`),
      },
    });

    const retryable = result.status === 'provider-error' || result.status === 'timeout';
    if (!retryable || attempt >= config.retries.iterationRetries || signal.aborted) return result;

    attempt += 1;
    logger.warn('retrying iteration', {
      iteration: context.iteration,
      attempt,
      reason: result.status,
    });
    await sleep(config.retries.backoffMs, signal);
  }
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
