import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { runIteration, type IterationResult } from './iteration.js';
import { ensureHandoff, handoffDir, handoffPath, readHandoff } from './handoff.js';
import { applySplit, describeIds, proposeSplit, splitDir, type StallCause } from './split.js';
import { diffSnapshots, snapshotRepo } from './progress.js';
import { pushBranch } from './push.js';
import { TERMINAL_STATUSES, type IterationStatus } from './outcome.js';
import { TaskStore } from '../tasks/store.js';
import { buildPrompt } from '../prompt/build.js';
import { buildWrapUpPrompt } from '../prompt/wrapup.js';
import { sleep } from '../opencode/server.js';
import { RunRecorder, newRunId, type RunState, type SplitRecord } from '../report/jsonl.js';
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
 * An iteration that runs out of time or context leaves a handoff for the next
 * attempt at its task. A task that keeps running out of either is probably too
 * big for one iteration: depending on `stall.onRepeatedTimeout`, the run stops,
 * proposes splitting it and stops, or splits it and carries on.
 *
 * Aborting `signal` interrupts the iteration in flight. Aborting `stop` lets
 * it finish, then ends the run before the next one, still pushing its commits.
 */
export async function runLoop(args: LoopArgs): Promise<RunResult> {
  const { config, logger } = args;
  const runId = newRunId();
  const recorder = new RunRecorder(
    resolve(config.projectRoot, config.ralphDir, 'history'),
    runId,
  );
  // The run's history keeps its log and where it stands, for the web UI.
  const detach = logger.addSink((entry) => recorder.recordLog(entry));
  const startedAt = new Date().toISOString();
  const state: RunState = {
    runId,
    status: 'running',
    pid: process.pid,
    hostname: hostname(),
    startedAt,
    updatedAt: startedAt,
    maxIterations: config.maxIterations,
    iteration: 0,
    taskId: null,
    iterationStartedAt: null,
    lastStatus: null,
    tasksPassed: 0,
    tasksTotal: 0,
  };
  const saveState = (patch: Partial<RunState>) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    recorder.recordState(state);
  };
  saveState({});

  try {
    const result = await loop(args, recorder, saveState);
    saveState({
      status: result.status,
      tasksPassed: result.tasksPassed,
      tasksTotal: result.tasksTotal,
      message: result.message,
    });
    return result;
  } catch (cause) {
    saveState({ status: 'crashed', message: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  } finally {
    detach();
  }
}

interface LoopArgs {
  config: Config;
  client: OpencodeClient;
  logger: Logger;
  reporter: ConsoleReporter;
  signal: AbortSignal;
  stop?: AbortSignal;
}

async function loop(
  args: LoopArgs,
  recorder: RunRecorder,
  saveState: (patch: Partial<RunState>) => void,
): Promise<RunResult> {
  const { config, client, logger, reporter, signal } = args;
  const stop = args.stop ?? new AbortController().signal;
  // Waits between iterations end early for either request.
  const pause = AbortSignal.any([signal, stop]);
  const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir);
  const runId = recorder.runId;

  let unproductive = 0;
  // What each task's attempts ran out of, in order.
  const cutShortByTask = new Map<string, StallCause[]>();
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
    const startedAt = new Date().toISOString();
    saveState({
      iteration,
      taskId,
      iterationStartedAt: startedAt,
      tasksPassed: summary.passedCount,
      tasksTotal: summary.total,
    });

    const before = await snapshotRepo(config.projectRoot, tasks, notProgress);

    const { result, cutShort, handoff } = await attemptIteration({
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
      cutShortLeft: config.stall.maxTimeoutsPerTask - (cutShortByTask.get(taskId)?.length ?? 0),
    });
    if (cutShort.length > 0) cutShortByTask.set(taskId, [...(cutShortByTask.get(taskId) ?? []), ...cutShort]);

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
    saveState({ lastStatus: status, ...taskCounts(tasks) });

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

    const causes = cutShortByTask.get(taskId) ?? [];
    if (causes.length >= config.stall.maxTimeoutsPerTask) {
      const stall = await handleStall({ args, recorder, iteration, taskId, causes, handoffFile, stop });
      if (stall.split) {
        // New tasks with new ids: the next iteration starts on the first of them.
        cutShortByTask.delete(taskId);
        unproductive = 0;
        if (stall.committed) unpushed = true;
        continue;
      }
      finalStatus = signal.aborted ? 'interrupted' : 'stalled';
      message = signal.aborted ? 'Interrupted' : stall.message;
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
 * Run an iteration, retrying the whole turn when the provider failed, the
 * agent timed out or its conversation outgrew the context window — those say
 * little about the task, mostly about the runtime. An attempt that runs out of
 * time or context leaves a handoff, so a retry starts a fresh session from it
 * rather than from nothing. One that wrapped up is not retried: the next
 * iteration resumes from its handoff instead.
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
  /** Attempts that may still run out of time or context before the task is given up on. */
  cutShortLeft: number;
}): Promise<{ result: IterationResult; cutShort: StallCause[]; handoff?: 'agent' | 'fallback' }> {
  const { client, config, logger, reporter, signal, stop } = context.args;
  const handoffShown = display(config, context.handoffFile);
  let attempt = 0;
  const cutShort: StallCause[] = [];
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
    const cause = stallCause(result);
    if (cause) {
      cutShort.push(cause);
      handoff = await ensureHandoff({
        path: context.handoffFile,
        projectRoot: config.projectRoot,
        taskId: context.taskId,
        iteration: context.iteration,
        since,
        sinceHead: context.sinceHead,
        reason: result.error ?? result.status,
        cutShortBy: ranOutOf(cause),
        agentText: result.text,
      });
      logger.info(handoff === 'agent' ? 'agent left a handoff' : 'agent left no handoff; wrote one from what the loop saw', {
        path: handoffShown,
      });
    }

    const done = { result, cutShort, ...(handoff ? { handoff } : {}) };
    const retryable =
      result.status === 'provider-error' || result.status === 'timeout' || result.status === 'context-overflow';
    // A retry is a fresh turn, which a stop request rules out.
    if (
      !retryable ||
      attempt >= config.retries.iterationRetries ||
      cutShort.length >= context.cutShortLeft ||
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

/** What cut an attempt short before it finished its task, if anything did. */
function stallCause(result: IterationResult): StallCause | undefined {
  if (result.status === 'context-overflow') return 'context';
  if (result.status !== 'wrapped-up' && result.status !== 'timeout') return undefined;
  return (result.wrapUp?.trigger ?? result.trip) === 'inactivity' ? 'inactivity' : 'iteration-timeout';
}

/** What a cause ran out of, as the handoff and messages say it. */
function ranOutOf(cause: StallCause): 'time' | 'context' {
  return cause === 'context' ? 'context' : 'time';
}

/**
 * Decide what becomes of a task that ran out of time or context too often.
 * A split is only tried when it could help: at least one attempt ran out of
 * working time or context (going quiet means a command hangs, which smaller
 * tasks would hit too), and the task has not been split too often already.
 */
async function handleStall(context: {
  args: LoopArgs;
  recorder: RunRecorder;
  iteration: number;
  taskId: string;
  causes: StallCause[];
  handoffFile: string;
  stop: AbortSignal;
}): Promise<{ split: true; committed: boolean } | { split: false; message: string }> {
  const { args, recorder, iteration, taskId, causes, handoffFile } = context;
  const { config, logger, reporter, signal } = args;
  const count = causes.length;
  const spent = `${taskId} ran out of ${[...new Set(causes.map(ranOutOf))].join(' or ')} ${count} time${count === 1 ? '' : 's'}`;
  const handoff = `(handoff: ${display(config, handoffFile)})`;
  const stopped = (message: string) => ({ split: false as const, message });

  const mode = config.stall.onRepeatedTimeout;
  if (mode === 'stop' || context.stop.aborted) return stopped(`${spent}; split it into smaller tasks ${handoff}`);
  if (causes.every((cause) => cause === 'inactivity')) {
    return stopped(
      `${spent}, going quiet each time: a command probably hangs, which splitting the task would not fix ${handoff}`,
    );
  }

  const task = TaskStore.forProject(config.projectRoot, config.ralphDir)
    .readTasks()
    .find((candidate) => candidate.id === taskId);
  const depth = task?.splitDepth ?? 0;
  if (depth >= config.stall.maxSplitDepth) {
    return stopped(
      config.stall.maxSplitDepth === 0
        ? `${spent}; split it into smaller tasks ${handoff}`
        : `${spent} after being split from ${task?.splitFrom ?? 'another task'}; stall.maxSplitDepth (${config.stall.maxSplitDepth}) allows no further split, so split it by hand ${handoff}`,
    );
  }

  const dir = splitDir(config.ralphDir, taskId);
  const startedAt = new Date().toISOString();
  const record = (patch: Omit<SplitRecord, 'iteration' | 'taskId' | 'causes' | 'startedAt' | 'endedAt'>) =>
    recorder.recordSplit({ iteration, taskId, causes, ...patch, startedAt, endedAt: new Date().toISOString() });

  logger.info('asking the agent to propose a split', { task: taskId, folder: dir });
  recorder.beginSplit(taskId);
  const outcome = await proposeSplit({
    client: args.client,
    config,
    logger,
    taskId,
    cutShort: causes.map(ranOutOf),
    signal,
    hooks: {
      onEvent: (event) => recorder.recordEvent(event),
      onText: (text) => reporter.status(truncate(text, 100)),
      onTool: (tool, detail) => reporter.status(`${tool} ${detail}`),
    },
  });

  if (outcome.status === 'failed') {
    logger.warn('could not propose a split', { task: taskId, reason: outcome.reason });
    record({ status: 'failed', reason: outcome.reason });
    return stopped(`${spent}; Ralph could not propose a split (${outcome.reason}), so split it by hand ${handoff}`);
  }
  if (outcome.status === 'declined') {
    logger.warn('the agent advises against splitting the task', { task: taskId, reason: outcome.reason });
    record({ status: 'declined', reason: outcome.reason });
    return stopped(`${spent}; splitting it would not help: ${outcome.reason} ${handoff}`);
  }

  const ids = outcome.proposal.tasks.map((child) => child.id);
  if (mode === 'propose') {
    logger.info('proposed a split', { task: taskId, into: ids.join(','), folder: dir });
    record({ status: 'proposed', children: ids, reason: outcome.proposal.reason });
    return stopped(
      `${spent}; proposed splitting it into ${describeIds(ids)} in ${dir}/. Review it, then run \`ralph split ${taskId} --apply\``,
    );
  }

  try {
    const applied = await applySplit({
      projectRoot: config.projectRoot,
      ralphDir: config.ralphDir,
      taskId,
      commit: true,
    });
    if (applied.commitError) logger.warn('could not commit the split', { task: taskId, error: applied.commitError });
    logger.info('split the task', { task: taskId, into: ids.join(','), committed: applied.committed });
    record({ status: 'applied', children: ids, reason: outcome.proposal.reason, committed: applied.committed });
    return { split: true, committed: applied.committed };
  } catch (cause) {
    const reason = (cause as Error).message;
    logger.warn('could not apply the split', { task: taskId, error: reason });
    record({ status: 'failed', children: ids, reason });
    return stopped(`${spent}; could not apply the split proposed in ${dir}/: ${reason}`);
  }
}

/** Current task counts; none when the agent left tasks.json unreadable, which the next iteration reports. */
function taskCounts(tasks: TaskStore): { tasksPassed?: number; tasksTotal?: number } {
  try {
    const summary = tasks.reload();
    return { tasksPassed: summary.passedCount, tasksTotal: summary.total };
  } catch {
    return {};
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
