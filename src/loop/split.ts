import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { runIteration, type IterationHooks } from './iteration.js';
import { handoffPath, readHandoff } from './handoff.js';
import { restrictWrites } from './permissions.js';
import { TaskStore, type Task } from '../tasks/store.js';
import { checkSpec, readTemplate, TASK_ID } from '../init/plan.js';
import { TEMPLATES_DIR } from '../init/scaffold.js';
import { buildSplitFixPrompt, buildSplitPrompt } from '../prompt/split.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

const run = promisify(execFile);

/**
 * What cut an attempt short: its working time, going quiet (the agent was
 * stuck in a tool), or the model's context window.
 */
export type StallCause = 'iteration-timeout' | 'inactivity' | 'context';

/** Times the split agent is sent back to fix a proposal that fails the checks. */
const MAX_FIX_ATTEMPTS = 2;

const ChildSchema = z.looseObject({ id: z.string(), title: z.string() });

const ProposalSchema = z.discriminatedUnion('splittable', [
  z.looseObject({
    task: z.string(),
    splittable: z.literal(true),
    reason: z.string().default(''),
    tasks: z.array(ChildSchema),
    appliedAt: z.string().optional(),
  }),
  z.looseObject({
    task: z.string(),
    splittable: z.literal(false),
    reason: z.string(),
    appliedAt: z.string().optional(),
  }),
]);

export type SplitProposal = z.infer<typeof ProposalSchema>;
export type Split = Extract<SplitProposal, { splittable: true }>;

export type SplitOutcome =
  | { status: 'proposed'; proposal: Split }
  | { status: 'declined'; reason: string }
  | { status: 'failed'; reason: string };

export class SplitError extends Error {}

/** Where a task's split is proposed and, once applied, archived; relative to the project root. */
export function splitDir(ralphDir: string, taskId: string): string {
  return `${ralphDir.replace(/\/+$/, '')}/split/${taskId}`;
}

/**
 * Check the proposal for `taskId` on disk, returning it or the problems the
 * agent (or the person editing it) can fix. Missing means no proposal yet.
 */
export function readProposal(
  projectRoot: string,
  ralphDir: string,
  taskId: string,
  tasks: Task[],
  templatesDir = TEMPLATES_DIR,
): { status: 'missing' } | { status: 'invalid'; problems: string[] } | { status: 'ok'; proposal: SplitProposal } {
  const dir = splitDir(ralphDir, taskId);
  const file = resolve(projectRoot, dir, 'proposal.json');
  if (!existsSync(file)) return { status: 'missing' };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    return { status: 'invalid', problems: [`${dir}/proposal.json is not valid JSON: ${(cause as Error).message}`] };
  }
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 'invalid',
      problems: [`${dir}/proposal.json does not match the expected shape:\n${z.prettifyError(parsed.error)}`],
    };
  }

  const proposal = parsed.data;
  const problems: string[] = [];
  if (proposal.task !== taskId) problems.push(`${dir}/proposal.json has task ${JSON.stringify(proposal.task)}, expected "${taskId}"`);
  if (!proposal.splittable) {
    if (!proposal.reason.trim()) problems.push(`${dir}/proposal.json needs a reason when the task is not splittable`);
    return problems.length > 0 ? { status: 'invalid', problems } : { status: 'ok', proposal };
  }

  if (proposal.tasks.length < 2) problems.push(`${dir}/proposal.json must list at least two tasks`);
  const existing = new Set(tasks.map((task) => task.id));
  const template = readTemplate(templatesDir, 'TASK-1.json');
  proposal.tasks.forEach((child, index) => {
    const expected = `${taskId}.${index + 1}`;
    if (child.id !== expected) {
      problems.push(`task ${index + 1} in ${dir}/proposal.json has id ${JSON.stringify(child.id)}, expected "${expected}"`);
      return;
    }
    if (!TASK_ID.test(child.id)) problems.push(`task ${child.id}: id must look like TASK-1`);
    if (existing.has(child.id)) problems.push(`task ${child.id} already exists in tasks.json`);
    if (!child.title.trim()) problems.push(`task ${child.id}: title is empty`);
    const spec = `${dir}/${child.id}.json`;
    problems.push(...checkSpec(resolve(projectRoot, spec), spec, child.id, template));
  });
  return problems.length > 0 ? { status: 'invalid', problems } : { status: 'ok', proposal };
}

/**
 * Have the agent propose a split of `taskId` in a session of its own, which
 * may write only in the task's split folder. Any earlier proposal is replaced.
 */
export async function proposeSplit(args: {
  client: OpencodeClient;
  config: Config;
  logger: Logger;
  taskId: string;
  /** What each attempt ran out of, for the prompt. */
  cutShort: string[];
  signal: AbortSignal;
  hooks?: IterationHooks;
  templatesDir?: string;
}): Promise<SplitOutcome> {
  const { client, config, logger, taskId, signal } = args;
  const { projectRoot, ralphDir } = config;
  const tasks = TaskStore.forProject(projectRoot, ralphDir).readTasks();
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { status: 'failed', reason: `${taskId} is not in tasks.json` };
  if (task.passes) return { status: 'failed', reason: `${taskId} already passes` };

  const dir = splitDir(ralphDir, taskId);
  rmSync(resolve(projectRoot, dir), { recursive: true, force: true });
  mkdirSync(resolve(projectRoot, dir), { recursive: true });

  const specFile = task.specFilePath ? resolve(projectRoot, task.specFilePath) : undefined;
  const handoffFile = handoffPath(projectRoot, ralphDir, taskId);
  const handoffText = readHandoff(handoffFile);
  const model = config.plan.model ?? config.model;
  const splitConfig: Config = model ? { ...config, model } : config;
  const permissions = restrictWrites(config.permissions, projectRoot, dir);

  let message = buildSplitPrompt({
    projectRoot,
    taskId,
    title: task.title,
    ...(specFile && existsSync(specFile)
      ? { specPath: task.specFilePath!, specText: readFileSync(specFile, 'utf8') }
      : {}),
    ...(handoffText ? { handoffPath: display(projectRoot, handoffFile), handoffText } : {}),
    commits: await git(projectRoot, ['log', '--oneline', '-n', '30', '--fixed-strings', `--grep=${taskId}`]),
    cutShort: args.cutShort,
    iterationMs: config.timeouts.iterationMs,
    proposalDir: dir,
  });
  let sessionId: string | undefined;

  for (let attempt = 0; ; attempt += 1) {
    const result = await runIteration({
      client,
      config: splitConfig,
      prompt: message,
      title: `ralph split · ${taskId}`,
      ...(sessionId ? { sessionId } : {}),
      permissions,
      logger,
      ...(args.hooks ? { hooks: args.hooks } : {}),
      signal,
    });
    sessionId = result.sessionId || sessionId;

    if (result.status === 'blocked') return { status: 'failed', reason: result.tags.blockedReason ?? 'the split agent is blocked' };
    if (!['progressed', 'no-progress', 'complete', 'decide'].includes(result.status)) {
      return { status: 'failed', reason: result.error ?? result.lastProviderError ?? `the split turn ended as ${result.status}` };
    }

    const read = readProposal(projectRoot, ralphDir, taskId, tasks, args.templatesDir);
    if (read.status === 'ok') {
      return read.proposal.splittable
        ? { status: 'proposed', proposal: read.proposal }
        : { status: 'declined', reason: read.proposal.reason.trim() };
    }
    const problems = read.status === 'missing' ? [`${dir}/proposal.json was not written`] : read.problems;
    if (attempt >= MAX_FIX_ATTEMPTS) {
      return { status: 'failed', reason: `the proposal still has problems: ${problems.join('; ')}` };
    }
    logger.info('sending the split proposal back to the agent to fix', { task: taskId, problems: problems.length });
    message = buildSplitFixPrompt(dir, problems);
  }
}

export interface AppliedSplit {
  children: Task[];
  /** Why the split was not committed, when it was not. */
  commitError?: string;
  committed: boolean;
}

/**
 * Replace `taskId` in tasks.json with the tasks its proposal lists, in its
 * place so they are picked up next, and move their specs next to the
 * parent's. The parent's spec and handoff are archived in the split folder,
 * which keeps the proposal as the record of the split. Commits the change
 * when `commit` is set and the project is a git repository.
 */
export async function applySplit(args: {
  projectRoot: string;
  ralphDir: string;
  taskId: string;
  commit: boolean;
  templatesDir?: string;
}): Promise<AppliedSplit> {
  const { projectRoot, ralphDir, taskId } = args;
  const store = TaskStore.forProject(projectRoot, ralphDir);
  const tasks = store.readTasks();
  const parent = tasks.find((task) => task.id === taskId);
  if (!parent) throw new SplitError(`${taskId} is not in tasks.json`);
  if (parent.passes) throw new SplitError(`${taskId} already passes`);

  const dir = splitDir(ralphDir, taskId);
  const read = readProposal(projectRoot, ralphDir, taskId, tasks, args.templatesDir);
  if (read.status === 'missing') throw new SplitError(`No split proposed for ${taskId}: ${dir}/proposal.json does not exist`);
  if (read.status === 'invalid') throw new SplitError(`The proposal in ${dir}/ has problems:\n${read.problems.map((p) => `- ${p}`).join('\n')}`);
  const proposal = read.proposal;
  if (!proposal.splittable) throw new SplitError(`The proposal in ${dir}/ advises against splitting ${taskId}: ${proposal.reason}`);

  const specDir = parent.specFilePath ? dirname(parent.specFilePath) : `${ralphDir.replace(/\/+$/, '')}/tasks`;
  const children: Task[] = proposal.tasks.map((child) => ({
    ...(child as Record<string, unknown>),
    id: child.id,
    title: child.title.trim(),
    ...(parent.category && !child['category'] ? { category: parent.category } : {}),
    specFilePath: posix(`${specDir}/${child.id}.json`),
    passes: false,
    splitFrom: taskId,
    splitDepth: (parent.splitDepth ?? 0) + 1,
  }));
  for (const child of children) {
    if (existsSync(resolve(projectRoot, child.specFilePath!))) {
      throw new SplitError(`${child.specFilePath} already exists`);
    }
  }

  // Edit the file as written, so a `{ tasks: [...] }` wrapper and unknown fields survive.
  const raw = JSON.parse(readFileSync(store.path, 'utf8')) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { tasks: unknown[] }).tasks) as Array<{ id?: unknown }>;
  const index = list.findIndex((task) => task.id === taskId);
  list.splice(index, 1, ...children);

  mkdirSync(resolve(projectRoot, specDir), { recursive: true });
  for (const child of children) {
    renameSync(resolve(projectRoot, dir, `${child.id}.json`), resolve(projectRoot, child.specFilePath!));
  }
  writeFileSync(store.path, `${JSON.stringify(raw, null, 2)}\n`);

  const touched = [display(projectRoot, store.path), dir, ...children.map((child) => child.specFilePath!)];
  if (parent.specFilePath && existsSync(resolve(projectRoot, parent.specFilePath))) {
    renameSync(resolve(projectRoot, parent.specFilePath), resolve(projectRoot, dir, `${taskId}.json`));
    touched.push(parent.specFilePath);
  }
  const handoffFile = handoffPath(projectRoot, ralphDir, taskId);
  if (existsSync(handoffFile)) {
    renameSync(handoffFile, resolve(projectRoot, dir, 'handoff.md'));
    touched.push(display(projectRoot, handoffFile));
  }
  writeFileSync(
    resolve(projectRoot, dir, 'proposal.json'),
    `${JSON.stringify({ ...proposal, appliedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  if (!args.commit) return { children, committed: false };
  const subject = `chore(plan): split ${taskId} into ${describeIds(children.map((child) => child.id))}`;
  const commitError = await commitPaths(projectRoot, touched, [subject, '', proposal.reason.trim()].join('\n').trim());
  return { children, committed: commitError === undefined, ...(commitError ? { commitError } : {}) };
}

/** `TASK-8.1 and TASK-8.2`, or `TASK-8.1–TASK-8.4` for more. */
export function describeIds(ids: string[]): string {
  if (ids.length <= 2) return ids.join(' and ');
  return `${ids[0]}–${ids[ids.length - 1]}`;
}

/** Stage and commit just these paths; returns why that failed, if it did. */
async function commitPaths(cwd: string, paths: string[], message: string): Promise<string | undefined> {
  try {
    await run('git', ['rev-parse', '--git-dir'], { cwd });
  } catch {
    return 'not a git repository';
  }
  try {
    // A moved file that was never tracked matches nothing and would fail the whole add.
    const known: string[] = [];
    for (const path of paths) {
      if (existsSync(resolve(cwd, path)) || (await git(cwd, ['ls-files', '--', path])) !== '') known.push(path);
    }
    await run('git', ['add', '-A', '--', ...known], { cwd });
    await run('git', ['commit', '-q', '-m', message, '--only', '--', ...known], { cwd });
    return undefined;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    return (error.stderr || error.message).trim().split('\n')[0];
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd });
    return stdout.trimEnd();
  } catch {
    return '';
  }
}

function display(projectRoot: string, path: string): string {
  return posix(relative(projectRoot, path));
}

function posix(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}
