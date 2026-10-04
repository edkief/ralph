import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { runIteration, type IterationHooks } from './iteration.js';
import { handoffPath, readHandoff } from './handoff.js';
import { restrictWrites } from './permissions.js';
import { taskCommits } from './split.js';
import { TaskStore } from '../tasks/store.js';
import { buildEscalationFixPrompt, buildEscalationPrompt } from '../prompt/escalate.js';
import { agentActionsFor, type Action, type PendingRequest } from '../human/request.js';
import type { Decision } from '../human/decisions.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

/** What the loop would have asked a person. */
export type EscalationRequest = Pick<PendingRequest, 'kind' | 'taskId' | 'message' | 'question' | 'split'>;

export type EscalationOutcome =
  /** Settled with an answer a person could have given. */
  | { status: 'resolved'; action: Action; text?: string; iterations?: number }
  /** Passed on to a person, with what the agent found. */
  | { status: 'escalated'; analysis: string }
  /** The turn gave no answer Ralph can act on: the request goes to a person as it is. */
  | { status: 'failed'; reason: string };

/** Times the agent is sent back for a reply Ralph cannot act on. */
const MAX_FIX_ATTEMPTS = 1;

/** The coding agent's last words the escalation agent sees, at most. */
const AGENT_TEXT_CHARS = 4_000;

/** The project's guidance for the escalation agent, in Ralph's folder. */
export const GUIDANCE_FILE = 'ESCALATION.md';

const RESOLVE = /<promise>\s*RESOLVE\s*:\s*([a-z]+)\s*(?::([^<]*))?<\/promise>/gi;
const ESCALATE = /<promise>\s*ESCALATE\s*:([^<]*)<\/promise>/gi;

export type ParsedEscalation =
  | Exclude<EscalationOutcome, { status: 'failed' }>
  | { status: 'invalid'; problem: string };

/**
 * The answer in the escalation agent's reply. `allowed` are the actions on
 * offer; a `continue` adds at most `maxIterations`.
 */
export function parseEscalation(text: string, allowed: Action[], maxIterations: number): ParsedEscalation {
  const resolves = [...text.matchAll(RESOLVE)];
  const escalates = [...text.matchAll(ESCALATE)];
  if (resolves.length + escalates.length === 0) return { status: 'invalid', problem: 'it ends with no RESOLVE or ESCALATE tag' };
  if (resolves.length + escalates.length > 1) return { status: 'invalid', problem: 'it has more than one RESOLVE or ESCALATE tag' };

  const escalate = escalates[0];
  if (escalate) {
    const analysis = (escalate[1] ?? '').trim();
    return analysis ? { status: 'escalated', analysis } : { status: 'invalid', problem: 'the ESCALATE tag says nothing for the person' };
  }

  const [, word = '', rest = ''] = resolves[0]!;
  const action = word.toLowerCase() as Action;
  if (!allowed.includes(action)) {
    return { status: 'invalid', problem: `"${word}" is not one of the answers on offer (${allowed.join(', ')})` };
  }
  if (action === 'continue') {
    const match = /^\s*(\d+)\s*(?::([\s\S]*))?$/.exec(rest);
    const count = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(count) || count <= 0) {
      return { status: 'invalid', problem: 'RESOLVE:continue needs a number of iterations, as in RESOLVE:continue:5:why' };
    }
    const why = match?.[2]?.trim();
    return { status: 'resolved', action, iterations: Math.min(count, maxIterations), ...(why ? { text: why } : {}) };
  }
  const note = rest.trim();
  if (action === 'answer' && !note) return { status: 'invalid', problem: 'RESOLVE:answer needs the answer after it' };
  return { status: 'resolved', action, ...(note ? { text: note } : {}) };
}

/**
 * What ESCALATION.md says to the agent: the file without its comments, and
 * nothing when only headings are left, as in the template `ralph init` writes.
 */
export function projectGuidance(text: string): string {
  const body = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const said = body.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  return said ? body : '';
}

/** Where the escalation agent may write: a folder of the run's history, out of git. */
export function escalationDir(ralphDir: string, runId: string): string {
  return `${ralphDir.replace(/\/+$/, '')}/history/${runId}/escalation`;
}

/**
 * Have the escalation agent settle `request` in a session of its own, within
 * `escalation.timeoutMs`. It may run commands, but write files only in the
 * run's escalation folder. The turn never fails the run: with no answer it
 * can act on, Ralph puts the request to a person.
 */
export async function runEscalation(args: {
  client: OpencodeClient;
  config: Config;
  logger: Logger;
  runId: string;
  request: EscalationRequest;
  /** What the coding agent last wrote, when the request comes from its iteration. */
  agentText?: string;
  decisions: Decision[];
  signal: AbortSignal;
  hooks?: IterationHooks;
}): Promise<EscalationOutcome> {
  const { client, config, logger, request, signal } = args;
  const { projectRoot, ralphDir } = config;
  const actions = agentActionsFor(request.kind);
  const dir = escalationDir(ralphDir, args.runId);
  mkdirSync(resolve(projectRoot, dir), { recursive: true });

  const task = request.taskId
    ? TaskStore.forProject(projectRoot, ralphDir)
        .readTasks()
        .find((candidate) => candidate.id === request.taskId)
    : undefined;
  const specFile = task?.specFilePath ? resolve(projectRoot, task.specFilePath) : undefined;
  const handoffFile = request.taskId ? handoffPath(projectRoot, ralphDir, request.taskId) : undefined;
  const handoffText = handoffFile ? readHandoff(handoffFile) : undefined;
  const guidanceFile = resolve(projectRoot, ralphDir, GUIDANCE_FILE);
  const guidance = existsSync(guidanceFile) ? projectGuidance(readFileSync(guidanceFile, 'utf8')) : '';
  const commits = request.taskId ? await taskCommits(projectRoot, request.taskId) : '';
  const model = config.escalation.model ?? config.plan.model ?? config.model;

  let message = buildEscalationPrompt({
    projectRoot,
    kind: request.kind,
    message: request.message,
    ...(request.question ? { question: request.question } : {}),
    ...(request.split ? { split: request.split } : {}),
    ...(task
      ? {
          task: {
            id: task.id,
            title: task.title,
            ...(specFile && existsSync(specFile)
              ? { specPath: task.specFilePath!, specText: readFileSync(specFile, 'utf8') }
              : {}),
          },
        }
      : request.taskId
        ? { task: { id: request.taskId, title: request.taskId } }
        : {}),
    ...(handoffFile && handoffText ? { handoffPath: display(projectRoot, handoffFile), handoffText } : {}),
    ...(commits ? { commits } : {}),
    ...(args.agentText?.trim() ? { agentText: args.agentText.trim().slice(-AGENT_TEXT_CHARS) } : {}),
    decisions: args.decisions,
    ...(guidance.trim() ? { guidance: { path: display(projectRoot, guidanceFile), text: guidance } } : {}),
    actions,
    maxIterations: config.maxIterations,
    timeoutMs: config.escalation.timeoutMs,
  });
  let sessionId: string | undefined;

  for (let attempt = 0; ; attempt += 1) {
    const result = await runIteration({
      client,
      // The turn's own budget, with no wrap-up: there is nothing to hand off.
      config: {
        ...config,
        ...(model ? { model } : {}),
        timeouts: { ...config.timeouts, iterationMs: config.escalation.timeoutMs, wrapUpMs: 0 },
      },
      prompt: message,
      title: `ralph escalation · ${request.kind}${request.taskId ? ` · ${request.taskId}` : ''}`,
      ...(sessionId ? { sessionId } : {}),
      permissions: restrictWrites(config.permissions, projectRoot, dir),
      logger,
      ...(args.hooks ? { hooks: args.hooks } : {}),
      signal,
    });
    sessionId = result.sessionId || sessionId;
    if (signal.aborted) return { status: 'failed', reason: 'interrupted' };

    const parsed = parseEscalation(result.text, actions, config.maxIterations);
    if (parsed.status !== 'invalid') return parsed;
    if (['provider-error', 'interrupted', 'failed', 'timeout', 'context-overflow'].includes(result.status)) {
      return { status: 'failed', reason: result.error ?? result.lastProviderError ?? `the escalation turn ended as ${result.status}` };
    }
    if (attempt >= MAX_FIX_ATTEMPTS) return { status: 'failed', reason: `the escalation agent gave no answer Ralph can act on: ${parsed.problem}` };
    logger.info('sending the escalation reply back to the agent to fix', { problem: parsed.problem });
    message = buildEscalationFixPrompt(parsed.problem, actions);
  }
}

function display(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join('/');
}
