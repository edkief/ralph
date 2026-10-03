import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySplit, describeIds, SplitError } from '../loop/split.js';
import { commitRecords, type RecordsMode } from '../loop/records.js';
import { RalphProject } from '../ui/project.js';
import { recordDecision } from './decisions.js';
import {
  checkAnswer,
  clearPending,
  readPending,
  RespondError,
  writeAnswer,
  type Answer,
  type AnswerInput,
  type PendingRequest,
  type PendingState,
} from './request.js';

export interface RespondResult {
  /** `loop`: handed to the waiting loop. `applied`: done here, as no loop is waiting. */
  delivered: 'loop' | 'applied';
  message: string;
}

/** The request waiting for a person, if any, and what can be done about it right now. */
export function pendingState(projectRoot: string, ralphDir: string): PendingState | undefined {
  return new RalphProject(projectRoot, ralphDir).pending();
}

/**
 * Answer the pending request. A waiting loop gets the answer and acts on it;
 * with no loop waiting, what can be done without one is done here (applying a
 * split, recording an answer for the next run) and the request is closed.
 * Then, unless `records` is `never`, what was recorded is committed, so the
 * next run finds it wherever it runs.
 */
export async function respond(args: {
  projectRoot: string;
  ralphDir: string;
  input: AnswerInput;
  by: 'ui' | 'cli';
  /** `git.records`: whether to commit what an answer with no loop waiting recorded. */
  records?: RecordsMode;
}): Promise<RespondResult> {
  const { projectRoot, ralphDir, input, by } = args;
  const ralphRoot = resolve(projectRoot, ralphDir);
  const state = pendingState(projectRoot, ralphDir);
  if (!state) throw new RespondError('Nothing is waiting for an answer', 'conflict');
  const { pending, waiting } = state;

  const problem = checkAnswer(pending, input, waiting);
  if (problem) throw new RespondError(problem, input.id === pending.id ? 'invalid' : 'conflict');

  const answer: Answer = { ...input, by, answeredAt: new Date().toISOString() };
  if (waiting) {
    writeAnswer(ralphRoot, answer);
    return { delivered: 'loop', message: 'Ralph has the answer and carries on.' };
  }

  let message: string;
  if (pending.kind === 'split' && answer.action === 'approve') {
    try {
      const applied = await applySplit({ projectRoot, ralphDir, taskId: pending.taskId ?? '', commit: true });
      const into = describeIds(applied.children.map((child) => child.id));
      message = applied.committed
        ? `Split ${pending.taskId} into ${into} and committed it. Run ralph again to continue.`
        : `Split ${pending.taskId} into ${into}, but could not commit it (${applied.commitError ?? 'unknown error'}); commit ${ralphDir}/ yourself, then run ralph again.`;
    } catch (cause) {
      if (cause instanceof SplitError) throw new RespondError(cause.message, 'invalid');
      throw cause;
    }
  } else if (answer.action === 'answer') {
    message = 'Recorded. The agent sees the answer in the next run: run ralph again to continue.';
  } else {
    message = 'Dismissed. Run ralph again to continue.';
  }
  recordAnswer(ralphRoot, pending, answer);
  clearPending(ralphRoot);
  if (args.records !== 'never') {
    // No loop is waiting, so no iteration can take this commit for progress.
    const committed = await commitRecords({
      projectRoot,
      ralphDir,
      subject: `chore(ralph): record ${answer.action} on ${pending.kind}`,
      runId: pending.runId,
    });
    if (committed.error) message += ` Could not commit it (${committed.error}); commit ${ralphDir}/ yourself.`;
  }
  return { delivered: 'applied', message };
}

/**
 * Keep what a person answered: in the run's history, and, when they wrote
 * something, among the decisions later prompts show the agent.
 */
export function recordAnswer(ralphRoot: string, pending: PendingRequest, answer: Answer): void {
  const runDir = resolve(ralphRoot, 'history', pending.runId);
  if (existsSync(runDir)) {
    appendFileSync(
      resolve(runDir, 'actions.jsonl'),
      `${JSON.stringify({ ...answer, kind: pending.kind, taskId: pending.taskId, message: pending.message })}\n`,
    );
  }
  const text = answer.text?.trim();
  if (text) {
    recordDecision(ralphRoot, {
      time: answer.answeredAt,
      runId: pending.runId,
      taskId: pending.taskId,
      kind: pending.kind,
      question: pending.question ?? pending.message,
      answer: text,
    });
  }
}
