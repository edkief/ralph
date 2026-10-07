import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runIteration } from '../loop/iteration.js';
import { isInside, restrictWrites } from '../loop/permissions.js';
import { RALPH_DIR_PLACEHOLDER } from '../prompt/build.js';
import { TaskStore, type Task } from '../tasks/store.js';
import { validatePlan } from './plan.js';
import { TEMPLATES_DIR } from './scaffold.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { OpencodeEvent } from '../opencode/events.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

const run = promisify(execFile);

const PLAN_DONE = /<promise>\s*PLAN\s*:\s*DONE\s*<\/promise>/i;
const DECIDE_TAG = /<promise>\s*DECIDE:([^<]*)<\/promise>/gi;
const PROMISE_TAG = /<promise>[^<]*<\/promise>/gi;

/** What the user sees of the agent's text: tags removed, except a question inside DECIDE. */
function displayText(text: string): string {
  return text.replace(DECIDE_TAG, '$1').replace(PROMISE_TAG, '').trim();
}

/** Typed by the user to have the agent stop asking and write the plan. */
export const DONE_COMMAND = '/done';

const WRITE_NOW =
  'Stop asking questions. Write the plan now, recording anything still open under Assumptions ' +
  'in the PRD, then summarise it and emit <promise>PLAN:DONE</promise>.';

/** How the interview talks to the user; a terminal in the CLI, a script in tests. */
export interface InterviewIO {
  /** Something the agent said. */
  say(text: string): void;
  /** Transient tool activity. */
  status(text: string): void;
  /** A notice from Ralph itself. */
  note(text: string): void;
  /** The user's reply, or null when they quit. */
  ask(prompt: string): Promise<string | null>;
  /** Turn `n` begins: the agent is at work. */
  turn?(n: number): void;
}

export type InterviewOutcome = { turns: number; outsideChanges: string[] | null } & (
  | { status: 'planned'; tasks: Task[] }
  | { status: 'invalid'; problems: string[] }
  | { status: 'aborted' }
  | { status: 'failed'; reason: string; cause: FailureCause }
);

/** Why an interview failed: the model, the server or turn, the agent's own BLOCKED, or the turn budget. */
export type FailureCause = 'provider' | 'server' | 'blocked' | 'turns';

/**
 * Plan the project with the user through the configured agent: take their
 * description, relay the agent's questions and their answers within one
 * session, and finish when the agent's plan passes validation.
 *
 * The agent may only write inside the Ralph folder. Permission requests are
 * answered accordingly, but opencode asks only for what its own config says
 * to ask about, so files changed elsewhere are also detected afterwards and
 * reported in `outsideChanges` (null when the project is not a git repo).
 */
export async function runInterview(args: {
  client: OpencodeClient;
  config: Config;
  logger: Logger;
  io: InterviewIO;
  signal: AbortSignal;
  replan?: boolean;
  templatesDir?: string;
  /** Each turn's raw opencode events, for its record. */
  onEvent?: (event: OpencodeEvent) => void;
}): Promise<InterviewOutcome> {
  const { client, config, logger, io, signal, replan = false } = args;
  const templatesDir = args.templatesDir ?? TEMPLATES_DIR;
  const model = config.plan.model ?? config.model;
  const planConfig: Config = model ? { ...config, model } : config;
  const permissions = restrictWrites(config.permissions, config.projectRoot, config.ralphDir);
  const before = await snapshotChanges(config.projectRoot);

  let turns = 0;
  const finish = async (outcome: DistributiveOmit<InterviewOutcome, 'turns' | 'outsideChanges'>) =>
    ({
      ...outcome,
      turns,
      outsideChanges: await outsideChanges(config.projectRoot, config.ralphDir, before),
    }) as InterviewOutcome;

  const description = await askNonEmpty(
    io,
    replan ? 'What should change in the plan?' : 'Describe the project: what it is, who it is for, what done looks like.',
  );
  if (description === null) return finish({ status: 'aborted' });

  let message = openingPrompt(config, templatesDir, replan, description);
  let sessionId: string | undefined;
  let fixAttempts = 0;

  while (turns < config.plan.maxTurns) {
    turns += 1;
    io.turn?.(turns);
    const result = await runIteration({
      client,
      config: planConfig,
      prompt: message,
      title: replan ? 'ralph init: replan' : 'ralph init: plan',
      ...(sessionId ? { sessionId } : {}),
      permissions,
      logger,
      hooks: {
        onText: (text) => {
          const shown = displayText(text);
          if (shown) io.say(shown);
        },
        onTool: (tool, detail) => io.status(`${tool} ${detail}`.trim()),
        ...(args.onEvent ? { onEvent: args.onEvent } : {}),
      },
      signal,
    });
    sessionId = result.sessionId || sessionId;

    switch (result.status) {
      case 'interrupted':
        return finish({ status: 'aborted' });
      case 'provider-error':
      case 'timeout':
      case 'context-overflow':
      case 'failed':
        return finish({
          status: 'failed',
          reason: result.error ?? result.lastProviderError ?? result.status,
          cause: result.status === 'provider-error' ? 'provider' : 'server',
        });
      case 'blocked':
        return finish({ status: 'failed', reason: result.tags.blockedReason ?? 'blocked', cause: 'blocked' });
      default:
        break;
    }

    if (PLAN_DONE.test(result.text)) {
      const problems = validatePlan(config.projectRoot, config.ralphDir, { replan, templatesDir });
      if (problems.length === 0) {
        const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
        return finish({ status: 'planned', tasks });
      }
      if (fixAttempts >= config.plan.maxFixAttempts) return finish({ status: 'invalid', problems });
      fixAttempts += 1;
      io.note(`The plan has ${problems.length} problem(s); sending it back to the agent to fix.`);
      message = fixPrompt(problems);
      continue;
    }

    const answer = await askNonEmpty(io, 'you');
    if (answer === null) return finish({ status: 'aborted' });
    message = answer.trim() === DONE_COMMAND ? WRITE_NOW : answer;
  }

  return finish({
    status: 'failed',
    reason: `the agent used all ${config.plan.maxTurns} turns without finishing the plan`,
    cause: 'turns',
  });
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

async function askNonEmpty(io: InterviewIO, prompt: string): Promise<string | null> {
  for (;;) {
    const answer = await io.ask(prompt);
    if (answer === null || answer.trim() !== '') return answer;
  }
}

function openingPrompt(config: Config, templatesDir: string, replan: boolean, description: string): string {
  const ralphDir = relative(config.projectRoot, resolve(config.projectRoot, config.ralphDir)) || '.';
  const instructions = readFileSync(resolve(templatesDir, 'PLAN.md'), 'utf8').replaceAll(
    RALPH_DIR_PLACEHOLDER,
    ralphDir,
  );
  return [
    `PROJECT_ROOT=${config.projectRoot}`,
    instructions,
    `## Mode\n\n${replan ? 'Revising an existing plan.' : 'Writing a new plan.'}`,
    `## ${replan ? 'What the owner wants changed' : "The owner's description"}\n\n${description.trim()}`,
  ].join('\n\n');
}

function fixPrompt(problems: string[]): string {
  return [
    'Ralph checked the plan files and found these problems:',
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Fix them in the files, then emit <promise>PLAN:DONE</promise> again.',
  ].join('\n');
}

/** Paths git reports as changed, each with its mtime, so later edits to already-dirty files show too. */
type ChangeSnapshot = Map<string, number | null>;

async function snapshotChanges(cwd: string): Promise<ChangeSnapshot | null> {
  try {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
    const { stdout } = await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd });
    const snapshot: ChangeSnapshot = new Map();
    const entries = stdout.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.length < 4) continue;
      // Porcelain paths are relative to the repository root, whatever the cwd.
      const path = resolve(top, entry.slice(3));
      snapshot.set(path, mtime(path));
      // A rename or copy is followed by its source path, which is not a change of its own.
      if (entry[0] === 'R' || entry[0] === 'C') index += 1;
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function outsideChanges(
  projectRoot: string,
  ralphDir: string,
  before: ChangeSnapshot | null,
): Promise<string[] | null> {
  if (!before) return null;
  const after = await snapshotChanges(projectRoot);
  if (!after) return null;

  const scope = resolve(projectRoot, ralphDir);
  return [...after]
    .filter(([path, time]) => !isInside(scope, path) && (!before.has(path) || before.get(path) !== time))
    .map(([path]) => relative(projectRoot, path))
    .sort();
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
