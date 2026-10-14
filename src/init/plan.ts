import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TASK_ID, TaskStore, type TaskInspection } from '../tasks/store.js';
import { TEMPLATES_DIR } from './scaffold.js';

export { TASK_ID } from '../tasks/store.js';

/** The task list `ralph init` laid down before tasks.json held only ids and status; still a template where found. */
const FORMER_TASKS_TEMPLATE = `[
  {
    "id": "TASK-1",
    "title": "Short description of the first unit of work",
    "category": "setup",
    "specFilePath": ".ralph/tasks/TASK-1.json",
    "passes": false
  }
]`;

/**
 * `template` while the PRD and task list are still what `ralph init` laid
 * down (or missing); `written` once either holds a real plan.
 */
export function planState(
  projectRoot: string,
  ralphDir: string,
  templatesDir = TEMPLATES_DIR,
): 'template' | 'written' {
  const prd = resolve(projectRoot, ralphDir, 'prd', 'PRD.md');
  const prdUntouched = !existsSync(prd) || sameText(readFileSync(prd, 'utf8'), readTemplate(templatesDir, 'PRD.md'));
  return prdUntouched && taskListUntouched(projectRoot, ralphDir, templatesDir, true) ? 'template' : 'written';
}

/**
 * Whether the task list is still the scaffold's: the list as laid down and
 * the example spec beside it. The list alone cannot tell, since a plan of
 * one task lists just what the template does. `missing` says whether
 * absent files count as untouched.
 */
function taskListUntouched(projectRoot: string, ralphDir: string, templatesDir: string, missing: boolean): boolean {
  const unchanged = (path: string, ...templates: string[]) =>
    existsSync(path) ? templates.some((template) => sameText(readFileSync(path, 'utf8'), template)) : missing;
  return (
    unchanged(resolve(projectRoot, ralphDir, 'tasks.json'), readTemplate(templatesDir, 'tasks.json'), FORMER_TASKS_TEMPLATE) &&
    unchanged(resolve(projectRoot, ralphDir, 'tasks', 'TASK-1.json'), readTemplate(templatesDir, 'TASK-1.json'))
  );
}

/**
 * Check a plan the agent wrote, returning problems it can fix. An empty list
 * means the loop can run it: a real PRD, and a task list that lists every
 * spec in the tasks folder, once, each with a loop-compatible id, a title
 * and acceptance criteria.
 */
export function validatePlan(
  projectRoot: string,
  ralphDir: string,
  options: { replan?: boolean; templatesDir?: string } = {},
): string[] {
  const templatesDir = options.templatesDir ?? TEMPLATES_DIR;
  const problems: string[] = [];
  const dir = (...parts: string[]) => resolve(projectRoot, ralphDir, ...parts);
  const shownDir = ralphDir.replace(/\/+$/, '');

  const prd = dir('prd', 'PRD.md');
  if (!existsSync(prd)) {
    problems.push(`${shownDir}/prd/PRD.md is missing`);
  } else if (sameText(readFileSync(prd, 'utf8'), readTemplate(templatesDir, 'PRD.md'))) {
    problems.push(`${shownDir}/prd/PRD.md is still the template`);
  }

  if (existsSync(dir('tasks.json')) && taskListUntouched(projectRoot, ralphDir, templatesDir, false)) {
    problems.push(`${shownDir}/tasks.json is still the template`);
    return problems;
  }

  let inspection: TaskInspection;
  try {
    inspection = TaskStore.forProject(projectRoot, ralphDir).inspect();
  } catch (cause) {
    problems.push((cause as Error).message);
    return problems;
  }
  const unlisted = new Set(inspection.unlisted);
  const tasks = inspection.tasks.filter((task) => !unlisted.has(task.id));
  if (tasks.length === 0) problems.push(`${shownDir}/tasks.json has no tasks`);

  const seen = new Set<string>();
  for (const task of tasks) {
    const label = `task ${task.id}`;
    if (!TASK_ID.test(task.id)) problems.push(`${label}: id must look like TASK-1`);
    if (seen.has(task.id)) {
      problems.push(`${label}: duplicate id`);
      continue;
    }
    seen.add(task.id);
    const spec = task.specFilePath ?? `${shownDir}/tasks/${task.id}.json`;
    const specProblems = checkSpec(resolve(projectRoot, spec), spec, task.id, readTemplate(templatesDir, 'TASK-1.json'));
    // The title is the spec's: only worth checking once the spec reads.
    if (specProblems.length === 0 && !task.title.trim()) problems.push(`${label}: title is empty`);
    if (task.passes && !options.replan) problems.push(`${label}: a new task must have "passes": false`);
    problems.push(...specProblems);
  }

  for (const id of inspection.unlisted) {
    problems.push(
      `${shownDir}/tasks/${id}.json is not in ${shownDir}/tasks.json: list it where it should run, or delete it if the task is dropped`,
    );
  }

  return problems;
}

/**
 * What `validatePlan` would find wrong with a plan that may have been written
 * anywhere (by hand, or by an agent outside `ralph init`), limited to what the
 * loop still has to run: a template PRD or task list, and unfinished tasks
 * whose spec is the template or lacks a title or acceptance criteria. Passed
 * tasks are history and not checked. Specs that are missing, unlisted or carry
 * another id are left to the task list check, which reports them already.
 */
export function pendingPlanProblems(projectRoot: string, ralphDir: string, templatesDir = TEMPLATES_DIR): string[] {
  const problems: string[] = [];
  const shownDir = ralphDir.replace(/\/+$/, '');
  const prd = resolve(projectRoot, ralphDir, 'prd', 'PRD.md');
  if (existsSync(prd) && sameText(readFileSync(prd, 'utf8'), readTemplate(templatesDir, 'PRD.md'))) {
    problems.push(`${shownDir}/prd/PRD.md is still the template`);
  }
  if (taskListUntouched(projectRoot, ralphDir, templatesDir, false)) {
    problems.push(`${shownDir}/tasks.json and its first spec are still the template`);
    return problems;
  }

  let inspection: TaskInspection;
  try {
    inspection = TaskStore.forProject(projectRoot, ralphDir).inspect();
  } catch {
    return problems;
  }
  const template = readTemplate(templatesDir, 'TASK-1.json');
  const unlisted = new Set(inspection.unlisted);
  for (const task of inspection.tasks) {
    if (task.passes || unlisted.has(task.id) || !task.specFilePath) continue;
    const path = resolve(projectRoot, task.specFilePath);
    if (!existsSync(path)) continue;
    const specProblems = checkSpec(path, task.specFilePath, task.id, template, { id: false });
    if (specProblems.length === 0 && !task.title.trim()) problems.push(`task ${task.id}: title is empty`);
    problems.push(...specProblems);
  }
  return problems;
}

/** Problems with one task's spec file, labelled with the task id. */
export function checkSpec(
  path: string,
  shown: string,
  taskId: string,
  template: string,
  options: { id?: boolean } = {},
): string[] {
  const label = `task ${taskId}`;
  if (!existsSync(path)) return [`${label}: spec ${shown} does not exist`];

  const text = readFileSync(path, 'utf8');
  if (sameText(text, template)) return [`${label}: spec ${shown} is still the template`];

  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (cause) {
    return [`${label}: spec ${shown} is not valid JSON: ${(cause as Error).message}`];
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return [`${label}: spec ${shown} must be a JSON object`];
  }

  const problems: string[] = [];
  const { id, acceptanceCriteria } = spec as Record<string, unknown>;
  if (options.id !== false && id !== taskId) problems.push(`${label}: spec ${shown} has id ${JSON.stringify(id)}, expected "${taskId}"`);
  if (
    !Array.isArray(acceptanceCriteria) ||
    acceptanceCriteria.length === 0 ||
    !acceptanceCriteria.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    problems.push(`${label}: spec ${shown} needs a non-empty acceptanceCriteria list of strings`);
  }
  return problems;
}

export function readTemplate(templatesDir: string, name: string): string {
  return readFileSync(resolve(templatesDir, name), 'utf8');
}

function sameText(a: string, b: string): boolean {
  const normalise = (text: string) => text.replace(/\r\n/g, '\n').trim();
  return normalise(a) === normalise(b);
}
