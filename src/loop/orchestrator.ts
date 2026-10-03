import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { runIteration, type IterationResult } from './iteration.js';
import { ensureHandoff, handoffDir, handoffPath, readHandoff } from './handoff.js';
import { assessDir, assessTask, shouldAssess } from './assess.js';
import { applySplit, describeIds, proposeSplit, readProposal, splitDir, type StallCause } from './split.js';
import { diffSnapshots, snapshotRepo } from './progress.js';
import { pushBranch } from './push.js';
import { commitParkedWork, commitRecords, journalDir, type RecordsCommit } from './records.js';
import { TERMINAL_STATUSES, type IterationStatus } from './outcome.js';
import { TaskStore, type Task } from '../tasks/store.js';
import { buildPrompt } from '../prompt/build.js';
import { buildWrapUpPrompt } from '../prompt/wrapup.js';
import { recentDecisions } from '../human/decisions.js';
import { recordAnswer } from '../human/respond.js';
import {
  clearPending,
  clearStopRequest,
  readStopRequest,
  waitForAnswer,
  writePending,
  type Answer,
  type PendingRequest,
} from '../human/request.js';
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
  /** Why Ralph's records could not be committed when the run ended, if they could not. */
  recordsError?: string;
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
 * proposes splitting it and stops, or splits it and carries on. With
 * `assess.mode` a task is assessed before its first attempt, and one estimated
 * to be too big is split without spending an attempt on it.
 *
 * Where the run would stop for a person (the agent is blocked or needs a
 * decision, a task stalled or has a split to review, the budget is spent), the
 * loop leaves a request in the Ralph folder. With `ui.wait` it then waits for
 * the answer, from the web UI or `ralph respond`, and carries on; without, it
 * exits as before and the request can still be settled for the next run.
 *
 * Aborting `signal` interrupts the iteration in flight. Aborting `stop` lets
 * it finish, then ends the run before the next one, still pushing its commits.
 * A stop request left in the Ralph folder (by the web UI) does the same.
 * Aborting `park` (or a park request in the folder) stops as well, but first
 * has the agent wrap up and hand off at once; then the work left uncommitted
 * is committed and the branch pushed, whatever `git.push` says.
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
    split: null,
  };
  const saveState = (patch: Partial<RunState>) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    recorder.recordState(state);
  };
  saveState({});

  // Requests and answers from an earlier run mean nothing to this one.
  const ralphRoot = resolve(config.projectRoot, config.ralphDir);
  clearPending(ralphRoot);
  clearStopRequest(ralphRoot);
  // The web UI asks for a stop through a file, as it may be another process.
  const stopLater = new AbortController();
  const stopNow = new AbortController();
  const parkNow = new AbortController();
  const stopWatch = setInterval(() => {
    const request = readStopRequest(ralphRoot);
    if (!request) return;
    clearStopRequest(ralphRoot);
    if (request.mode === 'now') {
      logger.warn('stop requested: stopping now, interrupting the current iteration');
      stopNow.abort();
    } else if (request.mode === 'park') {
      if (!parkNow.signal.aborted) logger.warn('park requested: handing off, then committing and pushing the work');
      parkNow.abort();
    } else if (!stopLater.signal.aborted) {
      logger.warn('stop requested: stopping after the current iteration');
    }
    stopLater.abort();
  }, args.pollMs ?? POLL_MS);
  const watched: LoopArgs = {
    ...args,
    signal: AbortSignal.any([args.signal, stopNow.signal]),
    stop: AbortSignal.any([...(args.stop ? [args.stop] : []), stopLater.signal]),
    park: AbortSignal.any([...(args.park ? [args.park] : []), parkNow.signal]),
  };

  try {
    const result = await loop(watched, recorder, saveState);
    saveState({
      status: result.status,
      tasksPassed: result.tasksPassed,
      tasksTotal: result.tasksTotal,
      message: result.message,
      pending: null,
    });
    return result;
  } catch (cause) {
    saveState({ status: 'crashed', message: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  } finally {
    clearInterval(stopWatch);
    detach();
  }
}

/** How often the loop looks for an answer or a stop request in the Ralph folder. */
const POLL_MS = 500;

interface LoopArgs {
  config: Config;
  client: OpencodeClient;
  logger: Logger;
  reporter: ConsoleReporter;
  signal: AbortSignal;
  stop?: AbortSignal;
  /** Hand the project over: wrap up and hand off now, stop, commit the work and push. */
  park?: AbortSignal;
  /** How often to look for answers and stop requests; for tests. */
  pollMs?: number;
  /**
   * Ask a person for more iterations when the budget is spent, if the run
   * waits for people. Off for a daemon's batch, which ends there: the daemon
   * itself takes the next batch.
   */
  askForMore?: boolean;
}

async function loop(
  args: LoopArgs,
  recorder: RunRecorder,
  saveState: (patch: Partial<RunState>) => void,
): Promise<RunResult> {
  const { config, client, logger, reporter, signal } = args;
  const park = args.park ?? new AbortController().signal;
  // A park is a stop that also hands off.
  const stop = AbortSignal.any([...(args.stop ? [args.stop] : []), park]);
  // Waits between iterations end early for either request.
  const pause = AbortSignal.any([signal, stop]);
  const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir);
  const runId = recorder.runId;
  const ralphRoot = resolve(config.projectRoot, config.ralphDir);
  const wait = config.ui.wait ?? config.ui.enabled;

  /**
   * Leave a request for a person and, when the run waits for people, wait
   * for the answer. Nothing comes back when it does not wait, or when a stop
   * was asked for first; the caller then ends the run as it always did.
   */
  let asked = 0;
  const ask = async (
    request: Pick<PendingRequest, 'kind' | 'taskId' | 'message' | 'question' | 'split'>,
    settled?: () => Answer | undefined,
  ): Promise<Answer | undefined> => {
    asked += 1;
    const pending: PendingRequest = {
      id: `${runId}-${asked}`,
      runId,
      ...request,
      waiting: wait && !pause.aborted,
      createdAt: new Date().toISOString(),
    };
    writePending(ralphRoot, pending);
    if (!pending.waiting) return undefined;

    reporter.clearStatus();
    saveState({ status: 'waiting', pending: { id: pending.id, kind: pending.kind, taskId: pending.taskId } });
    logger.warn('waiting for a person: answer in the web UI or with `ralph respond`', {
      kind: pending.kind,
      ...(pending.taskId ? { task: pending.taskId } : {}),
      about: truncate(pending.message, 200),
    });
    const answer = await waitForAnswer({
      ralphRoot,
      id: pending.id,
      signal: pause,
      pollMs: args.pollMs ?? POLL_MS,
      ...(settled ? { settled } : {}),
    });
    saveState({ status: 'running', pending: null });
    if (!answer) {
      // Stopped while waiting: the request stays, to be settled without the loop.
      writePending(ralphRoot, { ...pending, waiting: false });
      return undefined;
    }
    recordAnswer(ralphRoot, pending, answer);
    clearPending(ralphRoot);
    logger.info('a person answered', { kind: pending.kind, action: answer.action, by: answer.by });
    return answer;
  };

  let unproductive = 0;
  // What each task's attempts ran out of, in order.
  const cutShortByTask = new Map<string, StallCause[]>();
  // Tasks attempted again on the split agent's advice, which each may be once.
  const retriedTasks = new Set<string>();
  // Handoffs are how a task resumes, the journal what Ralph saw and decisions what people said: none is progress.
  const notProgress = [
    handoffDir(config.ralphDir),
    assessDir(config.ralphDir),
    journalDir(config.ralphDir),
    `${config.ralphDir.replace(/\/+$/, '')}/decisions.jsonl`,
  ];

  /**
   * Have a person settle a stall or a proposed split, any number of times: they
   * may turn a proposal down and ask for another. Ends on a split (or a fresh
   * start on the task), on a stop, or when nobody is asked.
   */
  const review = async (stall: StallContext, first: StallOutcome): Promise<StallOutcome> => {
    const { taskId } = stall;
    let outcome = first;
    // A task assessed too big that ends up with no proposal is attempted, not put to a person.
    while (!outcome.split && (outcome.proposal || !stall.estimate) && !signal.aborted) {
      const proposal = outcome.proposal;
      const answer = await ask(
        proposal
          ? { kind: 'split', taskId, message: outcome.message, split: describeProposal(config, taskId, proposal) }
          : { kind: 'stalled', taskId, message: outcome.message },
        // `ralph split --apply` settles it as well as an answer does.
        proposal ? () => appliedElsewhere(config, taskId) : undefined,
      );
      if (!answer || answer.action === 'stop') break;
      if (answer.action === 'repropose') {
        outcome = await handleStall({ ...stall, ...(answer.text?.trim() ? { note: answer.text.trim() } : {}), reproposed: true });
      } else if (answer.action === 'approve' && proposal) {
        outcome = appliedElsewhere(config, taskId)
          ? { split: true, committed: true }
          : // Recorded as its own step: the time since the proposal was the person's.
            await applyProposal(stall, { ...proposal, startedAt: new Date().toISOString() });
      } else {
        // Try the task again as it is, with what the person noted in the prompt.
        outcome = { split: true, committed: false };
      }
    }
    return outcome;
  };
  // Commits the loop has not yet published. A failed push leaves this set,
  // so the next push attempt (or the one at run end) catches up.
  let unpushed = false;
  // The task last worked on, which work left behind by a park belongs to.
  let lastTaskId: string | null = null;
  let iteration = 0;
  let budget = config.maxIterations;
  let finalStatus: RunResult['status'] = 'max-iterations';
  let message = '';

  for (iteration = 1; ; iteration += 1) {
    if (iteration > budget) {
      message = `Reached the ${budget} iteration budget with work outstanding`;
      if (pause.aborted || !tasks.reload().next || args.askForMore === false) break;
      const answer = await ask({ kind: 'budget', taskId: null, message });
      if (answer?.action !== 'continue') break;
      budget += answer.iterations ?? config.maxIterations;
      saveState({ maxIterations: budget });
    }

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
      message = `${park.aborted ? 'Parked' : 'Stopped on request'} after ${iteration - 1} iteration${iteration === 2 ? '' : 's'}`;
      iteration -= 1;
      break;
    }

    const next = summary.next;
    const taskId = next.id;
    lastTaskId = taskId;
    const handoffFile = handoffPath(config.projectRoot, config.ralphDir, taskId);

    if (shouldAssess(config, next)) {
      const tooBig = await assessBeforeAttempt({ args, recorder, saveState, iteration, task: next, handoffFile, stop });
      const outcome = tooBig ? await review(tooBig, await handleStall(tooBig)) : undefined;
      if (outcome?.split) {
        // New tasks in place of this one, or this one as it is: either way, not an iteration.
        unproductive = 0;
        if (outcome.committed) unpushed = true;
        iteration -= 1;
        continue;
      }
      if (signal.aborted || outcome?.proposal) {
        finalStatus = signal.aborted ? 'interrupted' : 'stalled';
        message = signal.aborted ? 'Interrupted' : (outcome?.message ?? '');
        iteration -= 1;
        break;
      }
      // It fits, or nothing came of the assessment: attempt the task as it is.
    }

    reporter.iterationStart(iteration, budget, taskId);
    recorder.beginIteration(iteration);
    const startedAt = new Date().toISOString();
    saveState({
      iteration,
      taskId,
      iterationStartedAt: startedAt,
      tasksPassed: summary.passedCount,
      tasksTotal: summary.total,
      split: null,
    });

    const before = await snapshotRepo(config.projectRoot, tasks, notProgress);

    const { result, cutShort, handoff } = await attemptIteration({
      args: { client, config, logger, reporter, signal, stop, park },
      recorder,
      iteration,
      // Built per attempt, so a retry sees the handoff the failed one left.
      prompt: () => {
        const text = readHandoff(handoffFile);
        const decisions = recentDecisions(ralphRoot, DECISIONS_SHOWN);
        return buildPrompt({
          projectRoot: config.projectRoot,
          ralphDir: config.ralphDir,
          iteration,
          maxIterations: budget,
          nextTask: next,
          pinTask: config.pinTask,
          timeBudget: {
            ms: config.timeouts.iterationMs,
            until: new Date(Date.now() + config.timeouts.iterationMs),
          },
          ...(text ? { handoff: { path: handoffFile, text } } : {}),
          ...(decisions.length > 0 ? { decisions } : {}),
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
    // After the snapshot, so Ralph's own commit is never taken for the agent's progress.
    if (config.git.records === 'iteration' && (await commitRunRecords(config, logger, runId, { iteration })).committed) {
      unpushed = true;
    }
    if (config.git.push === 'iteration' && unpushed) {
      unpushed = !(await publish(config, logger, { iteration }));
    }

    if (TERMINAL_STATUSES.has(status)) {
      const terminal = terminalMessage(status, result);
      if (status === 'blocked' || status === 'decide') {
        const answer = await ask({
          kind: status,
          taskId,
          message: terminal,
          ...(status === 'decide' ? { question: terminal } : {}),
        });
        if (answer && answer.action !== 'stop') {
          // The next iteration's prompt carries what the person said.
          unproductive = 0;
          continue;
        }
        if (signal.aborted) {
          finalStatus = 'interrupted';
          message = 'Interrupted';
          break;
        }
      }
      finalStatus = status;
      message = terminal;
      break;
    }

    const causes = cutShortByTask.get(taskId) ?? [];
    if (causes.length >= config.stall.maxTimeoutsPerTask) {
      const stall = { args, recorder, saveState, iteration, taskId, causes, handoffFile, stop, retried: retriedTasks.has(taskId) };
      const outcome = await review(stall, await handleStall(stall));
      if (outcome.split) {
        if (outcome.retry) {
          // One more attempt: cut short again, the task has stalled again.
          retriedTasks.add(taskId);
          cutShortByTask.set(taskId, causes.slice(1));
        } else {
          // New tasks with new ids, or a fresh start on this one.
          cutShortByTask.delete(taskId);
        }
        unproductive = 0;
        if (outcome.committed) unpushed = true;
        continue;
      }
      finalStatus = signal.aborted ? 'interrupted' : 'stalled';
      message = signal.aborted ? 'Interrupted' : outcome.message;
      break;
    }

    unproductive = delta.productive ? 0 : unproductive + 1;
    if (unproductive >= config.stall.maxUnproductiveIterations) {
      const stalled = `${unproductive} iterations in a row changed nothing (last: ${status}${
        result.error ? ` — ${result.error}` : ''
      })`;
      const answer = await ask({ kind: 'stalled', taskId, message: stalled });
      if (answer && answer.action !== 'stop') {
        unproductive = 0;
        continue;
      }
      finalStatus = signal.aborted ? 'interrupted' : 'stalled';
      message = signal.aborted ? 'Interrupted' : stalled;
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

  const finalSummary = tasks.reload();

  // The budget may run out on an iteration that finished the backlog; judge
  // the run by the task list, not by which loop exit was taken.
  if (finalStatus === 'max-iterations' && !finalSummary.next && finalSummary.total > 0) {
    finalStatus = 'complete';
    message = `All ${finalSummary.total} tasks pass`;
  }

  const runResult: RunResult = {
    status: finalStatus,
    iterations: Math.min(iteration, budget),
    runId,
    historyDir: recorder.directory,
    tasksPassed: finalSummary.passedCount,
    tasksTotal: finalSummary.total,
    message,
  };
  recorder.recordSummary(runResult);
  saveState({
    status: runResult.status,
    tasksPassed: runResult.tasksPassed,
    tasksTotal: runResult.tasksTotal,
    message: runResult.message,
    pending: null,
  });

  if (park.aborted && !signal.aborted && (await commitParked(config, logger, lastTaskId))) unpushed = true;
  // Whatever ended the run: the records are what the next one resumes from, wherever it runs.
  if (config.git.records !== 'never') {
    const records = await commitRunRecords(config, logger, runId, {});
    if (records.committed) unpushed = true;
    if (records.error) runResult.recordsError = records.error;
  }
  // A park is for picking the work up elsewhere: it pushes whatever git.push says.
  if (((config.git.push !== 'never' && unpushed) || park.aborted) && !signal.aborted) {
    await publish(config, logger, {});
  }
  return runResult;
}

/** Commit what a parked run left uncommitted, logging the outcome. Whether a commit was made. */
async function commitParked(config: Config, logger: Logger, taskId: string | null): Promise<boolean> {
  const result = await commitParkedWork({
    projectRoot: config.projectRoot,
    ralphDir: config.ralphDir,
    subject: `wip(${taskId ?? 'ralph'}): parked`,
  });
  if (result.error) logger.warn('could not commit the parked work', { error: result.error });
  else if (result.committed) logger.info('committed the work left uncommitted', { task: taskId ?? 'none' });
  if (result.untracked.length > 0) {
    logger.warn('untracked files left out of the commit; commit them yourself if they matter', {
      files: result.untracked.slice(0, 10).join(', ') + (result.untracked.length > 10 ? ` and ${result.untracked.length - 10} more` : ''),
    });
  }
  return result.committed;
}

/** Commit Ralph's records for the run, logging the outcome. */
async function commitRunRecords(
  config: Config,
  logger: Logger,
  runId: string,
  context: { iteration?: number },
): Promise<RecordsCommit> {
  const subject =
    context.iteration !== undefined
      ? `chore(ralph): record run ${runId}, iteration ${context.iteration}`
      : `chore(ralph): record run ${runId}`;
  const result = await commitRecords({ projectRoot: config.projectRoot, ralphDir: config.ralphDir, subject, runId });
  if (result.error) {
    logger.warn('could not commit Ralph\'s records', { ...context, error: result.error });
  } else if (result.committed) {
    logger.info('committed Ralph\'s records', { ...context, files: result.files.length });
  }
  return result;
}

/** Decisions shown to the agent: the latest ones, as old ones are in the code by now. */
const DECISIONS_SHOWN = 20;

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
    park: AbortSignal;
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
  const { client, config, logger, reporter, signal, stop, park } = context.args;
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
            park,
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
    // Parked by a person: handed off, but not a sign the task is too big.
    const parked = result.wrapUp?.trigger === 'park';
    const cause = stallCause(result);
    if (cause) cutShort.push(cause);
    if (cause || parked) {
      handoff = await ensureHandoff({
        path: context.handoffFile,
        projectRoot: config.projectRoot,
        taskId: context.taskId,
        iteration: context.iteration,
        since,
        sinceHead: context.sinceHead,
        reason: result.error ?? result.status,
        cutShortBy: cause ? ranOutOf(cause) : 'park',
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
  if (result.wrapUp?.trigger === 'park') return undefined;
  if (result.status !== 'wrapped-up' && result.status !== 'timeout') return undefined;
  return (result.wrapUp?.trigger ?? result.trip) === 'inactivity' ? 'inactivity' : 'iteration-timeout';
}

/** What a cause ran out of, as the handoff and messages say it. */
function ranOutOf(cause: StallCause): 'time' | 'context' {
  return cause === 'context' ? 'context' : 'time';
}

/** What the agent's turns may change without it being a change to the project. */
function planningPaths(config: Config): string[] {
  return [handoffDir(config.ralphDir), assessDir(config.ralphDir), `${config.ralphDir.replace(/\/+$/, '')}/split`];
}

/**
 * Run a planning turn (an assessment, a split proposal) and warn when the
 * project changed under it: such a turn is told to change nothing, which the
 * loop cannot enforce for what the agent runs in a shell.
 */
async function planning<T>(config: Config, logger: Logger, taskId: string, turn: () => Promise<T>): Promise<T> {
  const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir);
  const before = await snapshotRepo(config.projectRoot, tasks, planningPaths(config));
  const result = await turn();
  const delta = diffSnapshots(before, await snapshotRepo(config.projectRoot, tasks, planningPaths(config)));
  if (delta.productive) {
    logger.warn('the project changed during a planning turn, which should only plan', {
      task: taskId,
      committed: delta.committed,
      filesChanged: delta.filesChanged,
    });
  }
  return result;
}

/**
 * Assess `task` before its first attempt, in a triage turn of its own. Returns
 * what a split of it starts from when the agent estimates it too big, and
 * nothing when the task is to be attempted as it is: it fits, or the turn gave
 * no estimate.
 */
async function assessBeforeAttempt(context: {
  args: LoopArgs;
  recorder: RunRecorder;
  saveState: (patch: Partial<RunState>) => void;
  iteration: number;
  task: Task;
  handoffFile: string;
  stop: AbortSignal;
}): Promise<StallContext | undefined> {
  const { args, recorder, iteration, task } = context;
  const { config, logger, reporter, signal } = args;
  const taskId = task.id;
  const startedAt = new Date().toISOString();

  logger.info('assessing the task before attempting it', { task: taskId });
  recorder.beginSplit(taskId);
  context.saveState({ iteration, taskId, iterationStartedAt: null, split: { taskId, startedAt, phase: 'assess' } });
  const { assessment, sessionId, recorded } = await planning(config, logger, taskId, () =>
    assessTask({
      client: args.client,
      config,
      logger,
      task,
      signal,
      hooks: {
        onEvent: (event) => recorder.recordEvent(event),
        onText: (text) => reporter.status(truncate(text, 100)),
        onTool: (tool, detail) => reporter.status(`${tool} ${detail}`),
      },
    }),
  );
  reporter.clearStatus();

  const minutes = assessment.estimateMinutes;
  if (assessment.verdict === 'too-big' && minutes !== undefined) {
    logger.info('the task is estimated too big for one iteration', {
      task: taskId,
      estimateMinutes: minutes,
      thresholdMinutes: assessment.thresholdMinutes,
    });
    return {
      args,
      recorder,
      saveState: context.saveState,
      iteration,
      taskId,
      causes: [],
      handoffFile: context.handoffFile,
      stop: context.stop,
      estimate: { minutes, thresholdMinutes: assessment.thresholdMinutes, startedAt, ...(sessionId ? { sessionId } : {}) },
    };
  }

  if (assessment.verdict === 'fits') {
    logger.info('the task is estimated to fit one iteration', { task: taskId, estimateMinutes: minutes });
  } else {
    logger.warn('could not assess the task; attempting it as it is', { task: taskId, reason: assessment.reason, retried: !recorded });
  }
  recorder.recordSplit({
    iteration,
    taskId,
    causes: [],
    trigger: 'assessment',
    status: assessment.verdict === 'fits' ? 'fits' : 'failed',
    ...(minutes !== undefined ? { estimateMinutes: minutes } : {}),
    reason: assessment.reason,
    startedAt,
    endedAt: new Date().toISOString(),
  });
  return undefined;
}

/**
 * Decide what becomes of a task that ran out of time or context too often, or
 * that was estimated too big before any attempt (`estimate`).
 * After a stall, a split is only tried when it could help: at least one attempt
 * ran out of working time or context (going quiet means a command hangs, which
 * smaller tasks would hit too), and the task has not been split too often already.
 */
interface StallContext {
  args: LoopArgs;
  recorder: RunRecorder;
  saveState: (patch: Partial<RunState>) => void;
  iteration: number;
  taskId: string;
  causes: StallCause[];
  handoffFile: string;
  stop: AbortSignal;
  /** What a person who turned down an earlier proposal asked for. */
  note?: string;
  /** Set when the task was assessed too big before any attempt, rather than stalled. */
  estimate?: {
    minutes: number;
    thresholdMinutes: number;
    /** When the triage turn started, which the split turn is recorded with. */
    startedAt: string;
    /** The triage session, which the first split turn carries on in. */
    sessionId?: string;
  };
  /** A person asked for another proposal: a turn of its own, in a new session. */
  reproposed?: boolean;
  /** The task was already attempted again on the split agent's advice, which is not taken twice. */
  retried?: boolean;
}

/** Why the task is up for a split, as the messages to a person start. */
function whySplit(context: Pick<StallContext, 'taskId' | 'causes' | 'estimate'>): string {
  const { taskId, causes, estimate } = context;
  if (estimate) {
    return `${taskId} was estimated at ${estimate.minutes} minutes before any attempt, over the ${estimate.thresholdMinutes} minutes a task may take`;
  }
  const count = causes.length;
  return `${taskId} ran out of ${[...new Set(causes.map(ranOutOf))].join(' or ')} ${count} time${count === 1 ? '' : 's'}`;
}

/** A split the agent proposed and nobody has applied yet. */
interface Proposed {
  ids: string[];
  titles: string[];
  reason: string;
  /** When the turn that proposed it started. */
  startedAt: string;
}

type StallOutcome =
  /** `retry` when the task is attempted again as it is, on the split agent's advice. */
  | { split: true; committed: boolean; retry?: true }
  /** `proposal` when the run stops over a split to review rather than over the stall itself. */
  | { split: false; message: string; proposal?: Proposed };

async function handleStall(context: StallContext): Promise<StallOutcome> {
  const { args, recorder, iteration, taskId, causes, handoffFile } = context;
  const { config, logger, reporter, signal } = args;
  const { estimate } = context;
  const spent = whySplit(context);
  // An assessed task has had no attempt, so no handoff either.
  const handoff = estimate ? '' : ` (handoff: ${display(config, handoffFile)})`;
  const stopped = (message: string) => ({ split: false as const, message: `${message}${handoff}` });

  const mode = estimate ? config.assess.mode : config.stall.onRepeatedTimeout;
  if (mode === 'stop' || mode === 'off' || context.stop.aborted) return stopped(`${spent}; split it into smaller tasks`);
  if (!estimate && causes.every((cause) => cause === 'inactivity')) {
    return stopped(
      `${spent}, going quiet each time: a command probably hangs, which splitting the task would not fix`,
    );
  }

  const task = TaskStore.forProject(config.projectRoot, config.ralphDir)
    .readTasks()
    .find((candidate) => candidate.id === taskId);
  const depth = task?.splitDepth ?? 0;
  if (depth >= config.stall.maxSplitDepth) {
    return stopped(
      config.stall.maxSplitDepth === 0
        ? `${spent}; split it into smaller tasks`
        : `${spent} after being split from ${task?.splitFrom ?? 'another task'}; stall.maxSplitDepth (${config.stall.maxSplitDepth}) allows no further split, so split it by hand`,
    );
  }

  const dir = splitDir(config.ralphDir, taskId);
  // The first split turn of an assessed task carries on from its triage: same session, same record.
  const carriesOn = estimate !== undefined && !context.reproposed;
  const startedAt = carriesOn ? estimate.startedAt : new Date().toISOString();
  const record = (patch: Omit<SplitRecord, 'iteration' | 'taskId' | 'causes' | 'trigger' | 'estimateMinutes' | 'startedAt' | 'endedAt'>) =>
    recorder.recordSplit({
      iteration,
      taskId,
      causes,
      trigger: estimate ? 'assessment' : 'stall',
      ...(estimate ? { estimateMinutes: estimate.minutes } : {}),
      ...patch,
      startedAt,
      endedAt: new Date().toISOString(),
    });

  logger.info('asking the agent to propose a split', { task: taskId, folder: dir });
  if (!carriesOn) recorder.beginSplit(taskId);
  context.saveState({ split: { taskId, startedAt, phase: 'split' } });
  const outcome = await planning(config, logger, taskId, () =>
    proposeSplit({
      client: args.client,
      config,
      logger,
      taskId,
      cutShort: causes.map(ranOutOf),
      ...(context.note ? { note: context.note } : {}),
      ...(estimate ? { estimate: { minutes: estimate.minutes, thresholdMinutes: estimate.thresholdMinutes } } : {}),
      ...(carriesOn && estimate.sessionId ? { sessionId: estimate.sessionId } : {}),
      // An assessed task has had no attempt to try again.
      allowRetry: !estimate && !context.retried,
      signal,
      hooks: {
        onEvent: (event) => recorder.recordEvent(event),
        onText: (text) => reporter.status(truncate(text, 100)),
        onTool: (tool, detail) => reporter.status(`${tool} ${detail}`),
      },
    }),
  );

  if (outcome.status === 'failed') {
    logger.warn('could not propose a split', { task: taskId, reason: outcome.reason });
    record({ status: 'failed', reason: outcome.reason });
    return stopped(`${spent}; Ralph could not propose a split (${outcome.reason}), so split it by hand`);
  }
  if (outcome.status === 'retry') {
    logger.info('the agent advises attempting the task again as it is', { task: taskId, reason: outcome.reason });
    record({ status: 'retry', reason: outcome.reason });
    return { split: true, committed: false, retry: true };
  }
  if (outcome.status === 'declined') {
    logger.warn('the agent advises against splitting the task', { task: taskId, reason: outcome.reason });
    record({ status: 'declined', reason: outcome.reason });
    return stopped(`${spent}; splitting it would not help: ${outcome.reason}`);
  }

  const ids = outcome.proposal.tasks.map((child) => child.id);
  const proposal: Proposed = {
    ids,
    titles: outcome.proposal.tasks.map((child) => child.title),
    reason: outcome.proposal.reason,
    startedAt,
  };
  if (mode === 'propose') {
    logger.info('proposed a split', { task: taskId, into: ids.join(','), folder: dir });
    record({ status: 'proposed', children: ids, reason: outcome.proposal.reason });
    return {
      split: false,
      message: `${spent}; proposed splitting it into ${describeIds(ids)} in ${dir}/. Review it, then run \`ralph split ${taskId} --apply\``,
      proposal,
    };
  }
  return applyProposal(context, proposal);
}

/** Replace the stalled task with the tasks proposed for it, and commit that. */
async function applyProposal(context: StallContext, proposal: Proposed): Promise<StallOutcome> {
  const { args, recorder, iteration, taskId, causes, estimate } = context;
  const { config, logger } = args;
  const record = (patch: Pick<SplitRecord, 'status' | 'reason' | 'committed'>) =>
    recorder.recordSplit({
      iteration,
      taskId,
      causes,
      trigger: estimate ? 'assessment' : 'stall',
      ...(estimate ? { estimateMinutes: estimate.minutes } : {}),
      children: proposal.ids,
      ...patch,
      startedAt: proposal.startedAt,
      endedAt: new Date().toISOString(),
    });

  try {
    const applied = await applySplit({
      projectRoot: config.projectRoot,
      ralphDir: config.ralphDir,
      taskId,
      commit: true,
    });
    if (applied.commitError) logger.warn('could not commit the split', { task: taskId, error: applied.commitError });
    logger.info('split the task', { task: taskId, into: proposal.ids.join(','), committed: applied.committed });
    record({ status: 'applied', reason: proposal.reason, committed: applied.committed });
    return { split: true, committed: applied.committed };
  } catch (cause) {
    const reason = (cause as Error).message;
    logger.warn('could not apply the split', { task: taskId, error: reason });
    record({ status: 'failed', reason });
    return {
      split: false,
      message: `${whySplit(context)}; could not apply the split proposed in ${splitDir(config.ralphDir, taskId)}/: ${reason}`,
    };
  }
}

/** A proposal as a person is asked to review it. */
function describeProposal(config: Config, taskId: string, proposal: Proposed): NonNullable<PendingRequest['split']> {
  const dir = splitDir(config.ralphDir, taskId);
  return {
    dir,
    reason: proposal.reason,
    tasks: proposal.ids.map((id, index) => ({ id, title: proposal.titles[index] ?? '', specPath: `${dir}/${id}.json` })),
  };
}

/** The answer that stands in for a split applied outside the loop, by `ralph split --apply`. */
function appliedElsewhere(config: Config, taskId: string): Answer | undefined {
  const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
  const read = readProposal(config.projectRoot, config.ralphDir, taskId, tasks);
  if (read.status !== 'ok' || !read.proposal.appliedAt) return undefined;
  return { id: taskId, action: 'approve', by: 'cli', answeredAt: read.proposal.appliedAt };
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
