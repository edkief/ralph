import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { handoffDir } from './handoff.js';
import { readProposal, splitDir } from './split.js';
import { changedFiles, isRepository } from './records.js';
import type { Config } from '../config/schema.js';
import type { AgentHarness, CheckResult } from '../harness/types.js';
import { TaskStore, type TaskInspection } from '../tasks/store.js';

const run = promisify(execFile);

/**
 * Verify the environment before burning an iteration on it. Checks the files
 * Ralph needs, then whatever the harness checks of itself (for opencode: its
 * version, required API operations, model availability and skill wiring).
 */
export async function preflight(config: Config, harness: AgentHarness): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const ralphPath = (...parts: string[]) => resolve(config.projectRoot, config.ralphDir, ...parts);

  results.push(fileCheck('prompt', ralphPath('PROMPT.md'), true, 'run `ralph init` to scaffold one'));
  results.push(fileCheck('prd', ralphPath('prd', 'PRD.md'), false));

  const store = TaskStore.forProject(config.projectRoot, config.ralphDir);
  try {
    const summary = store.reload();
    results.push({
      name: 'tasks',
      ok: true,
      detail: `${summary.passedCount}/${summary.total} passing, next ${summary.next?.id ?? 'none'}`,
      fatal: true,
    });
  } catch (cause) {
    results.push({ name: 'tasks', ok: false, detail: (cause as Error).message, fatal: true });
  }

  const taskList = taskListCheck(config);
  if (taskList) results.push(taskList);
  const handoffs = handoffCheck(config);
  if (handoffs) results.push(handoffs);
  const splits = splitCheck(config);
  if (splits) results.push(splits);
  const uncommitted = await uncommittedCheck(config);
  if (uncommitted) results.push(uncommitted);
  const upstream = await upstreamCheck(config);
  if (upstream) results.push(upstream);
  const artifacts = artifactsCheck(config);
  if (artifacts) results.push(artifacts);

  results.push(...(await harness.preflight(config)));

  return results;
}

/**
 * Where tasks.json and the specs in the tasks folder disagree. A listed task
 * that has not passed and has no spec cannot be run, which stops the run; the
 * rest are warnings. Returns nothing when they agree, or when the list does not
 * read, which the `tasks` check reports.
 */
export function taskListCheck(config: Config): CheckResult | undefined {
  let inspection: TaskInspection;
  try {
    inspection = TaskStore.forProject(config.projectRoot, config.ralphDir).inspect();
  } catch {
    return undefined;
  }
  const dir = config.ralphDir.replace(/\/+$/, '');
  const pending = inspection.missingSpec.filter((task) => !task.passes).map((task) => task.id);
  const passed = inspection.missingSpec.filter((task) => task.passes).map((task) => task.id);

  const details: string[] = [];
  if (pending.length > 0) details.push(`listed with no spec in ${dir}/tasks/, so they cannot run: ${some(pending)}`);
  if (inspection.unlisted.length > 0) {
    details.push(`specs not in ${dir}/tasks.json, so they run after the listed tasks: ${some(inspection.unlisted)}`);
  }
  if (inspection.idMismatch.length > 0) {
    details.push(
      `specs whose id is not their file's: ${some(inspection.idMismatch.map(({ id, specId }) => `${id} (says ${JSON.stringify(specId)})`))}`,
    );
  }
  if (inspection.leftBehind.length > 0) {
    details.push(`specs of tasks that were split, never run, delete them: ${some(inspection.leftBehind)}`);
  }
  if (passed.length > 0) details.push(`passing tasks listed with no spec: ${some(passed)}`);
  if (details.length === 0) return undefined;
  return { name: 'task list', ok: false, detail: details.join('; '), fatal: pending.length > 0 };
}

/** The first few of `ids`, and how many more. */
function some(ids: string[]): string {
  return ids.slice(0, 5).join(', ') + (ids.length > 5 ? ` and ${ids.length - 5} more` : '');
}

/**
 * Handoffs are how timed-out tasks resume. One for a task that already
 * passes was left behind, and would mislead anyone reading the folder.
 * Returns nothing when there are none.
 */
export function handoffCheck(config: Config): CheckResult | undefined {
  const dir = resolve(config.projectRoot, handoffDir(config.ralphDir));
  const ids = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length))
    : [];
  if (ids.length === 0) return undefined;

  let outstanding: Set<string>;
  try {
    const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
    outstanding = new Set(tasks.filter((task) => !task.passes).map((task) => task.id));
  } catch {
    return undefined;
  }

  const stale = ids.filter((id) => !outstanding.has(id));
  const resuming = ids.filter((id) => outstanding.has(id));
  if (stale.length > 0) {
    return {
      name: 'handoffs',
      ok: false,
      detail: `left behind for tasks that pass or no longer exist, delete them: ${stale.join(', ')}`,
      fatal: false,
    };
  }
  return { name: 'handoffs', ok: true, detail: `resuming from a handoff: ${resuming.join(', ')}`, fatal: false };
}

/**
 * What another machine would not get from the repository: files in the Ralph
 * folder (bar its history) that are not committed. Returns nothing when there
 * are none, or outside a repository.
 */
export async function uncommittedCheck(config: Config): Promise<CheckResult | undefined> {
  if (!(await isRepository(config.projectRoot))) return undefined;
  const dir = config.ralphDir.replace(/\/+$/, '');
  const files = await changedFiles(config.projectRoot, [dir, `:(exclude)${dir}/history`]);
  if (files.length === 0) return undefined;
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
  return {
    name: 'records',
    ok: false,
    detail: `${files.length} uncommitted in ${dir}/, which another machine would not get: ${shown}. Commit them, or \`ralph stop --park\``,
    fatal: false,
  };
}

/**
 * Commits another machine would not get: the branch is ahead of its upstream
 * (as last fetched), or has none while a remote exists. Returns nothing when
 * all is pushed, or outside a repository.
 */
export async function upstreamCheck(config: Config): Promise<CheckResult | undefined> {
  const cwd = config.projectRoot;
  if (!(await isRepository(cwd))) return undefined;
  const git = async (...args: string[]) => {
    try {
      return (await run('git', args, { cwd })).stdout.trim();
    } catch {
      return undefined;
    }
  };
  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (!upstream) {
    if (!(await git('remote'))) return undefined;
    const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')) ?? 'HEAD';
    return {
      name: 'upstream',
      ok: false,
      detail: `${branch} has no upstream branch, so its commits stay on this machine: \`git push -u ${config.git.remote} ${branch}\``,
      fatal: false,
    };
  }
  const ahead = Number((await git('rev-list', '--count', `${upstream}..HEAD`)) ?? 0);
  if (ahead === 0) return undefined;
  return {
    name: 'upstream',
    ok: false,
    detail: `${ahead} commit${ahead === 1 ? '' : 's'} not pushed to ${upstream}, which another machine would not get`,
    fatal: false,
  };
}

/** Beyond this, the artifacts kept in git weigh on every clone. */
export const ARTIFACTS_WARN_BYTES = 25 * 1024 * 1024;

/**
 * The evidence agents keep in `artifacts/` is committed, so every clone
 * carries it for good. Returns nothing while it stays small.
 */
export function artifactsCheck(config: Config, limit = ARTIFACTS_WARN_BYTES): CheckResult | undefined {
  const root = resolve(config.projectRoot, config.ralphDir, 'artifacts');
  let bytes = 0;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) bytes += statSync(path).size;
    }
  };
  if (existsSync(root)) visit(root);
  if (bytes <= limit) return undefined;
  const mb = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return {
    name: 'artifacts',
    ok: false,
    detail: `${config.ralphDir.replace(/\/+$/, '')}/artifacts/ holds ${mb(bytes)} (over ${mb(limit)}), which every clone carries: prune it, or track it with Git LFS`,
    fatal: false,
  };
}

/**
 * A split proposed for a task still in the plan waits on a person, and the
 * loop would otherwise run the task as it is again. Returns nothing when no
 * proposal is waiting.
 */
export function splitCheck(config: Config): CheckResult | undefined {
  const root = resolve(config.projectRoot, config.ralphDir, 'split');
  if (!existsSync(root)) return undefined;

  let tasks;
  try {
    tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
  } catch {
    return undefined;
  }
  const outstanding = new Set(tasks.filter((task) => !task.passes).map((task) => task.id));
  const waiting = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && outstanding.has(entry.name))
    .map((entry) => entry.name)
    .filter((id) => {
      const read = readProposal(config.projectRoot, config.ralphDir, id, tasks);
      return read.status !== 'missing' && !(read.status === 'ok' && (read.proposal.appliedAt || !read.proposal.splittable));
    });
  if (waiting.length === 0) return undefined;
  return {
    name: 'splits',
    ok: false,
    detail: `proposed but not applied, so the loop runs the task as it is: ${waiting
      .map((id) => `${id} (\`ralph split ${id} --apply\`, or delete ${splitDir(config.ralphDir, id)}/)`)
      .join(', ')}`,
    fatal: false,
  };
}

function fileCheck(name: string, path: string, fatal: boolean, hint?: string): CheckResult {
  const ok = existsSync(path);
  return { name, ok, detail: ok ? path : `missing: ${path}${hint ? ` — ${hint}` : ''}`, fatal };
}
