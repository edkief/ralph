import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskStore } from '../tasks/store.js';
import { TEMPLATES_DIR } from './scaffold.js';

/** Must match the loop's `<promise>TASK-x:DONE</promise>` tag, or progress is never recognised. */
const TASK_ID = /^TASK-[A-Za-z0-9._-]+$/;

/**
 * `template` while the PRD and task list are still what `ralph init` laid
 * down (or missing); `written` once either holds a real plan.
 */
export function planState(
  projectRoot: string,
  ralphDir: string,
  templatesDir = TEMPLATES_DIR,
): 'template' | 'written' {
  const untouched = (file: string, template: string) => {
    const path = resolve(projectRoot, ralphDir, file);
    return !existsSync(path) || sameText(readFileSync(path, 'utf8'), readTemplate(templatesDir, template));
  };
  return untouched('prd/PRD.md', 'PRD.md') && untouched('tasks.json', 'tasks.json') ? 'template' : 'written';
}

/**
 * Check a plan the agent wrote, returning problems it can fix. An empty list
 * means the loop can run it: a real PRD, and a task list whose every task has
 * a loop-compatible id and a spec with acceptance criteria.
 */
export function validatePlan(
  projectRoot: string,
  ralphDir: string,
  options: { replan?: boolean; templatesDir?: string } = {},
): string[] {
  const templatesDir = options.templatesDir ?? TEMPLATES_DIR;
  const problems: string[] = [];
  const dir = (...parts: string[]) => resolve(projectRoot, ralphDir, ...parts);

  const prd = dir('prd', 'PRD.md');
  if (!existsSync(prd)) {
    problems.push(`${ralphDir}/prd/PRD.md is missing`);
  } else if (sameText(readFileSync(prd, 'utf8'), readTemplate(templatesDir, 'PRD.md'))) {
    problems.push(`${ralphDir}/prd/PRD.md is still the template`);
  }

  const tasksFile = dir('tasks.json');
  if (existsSync(tasksFile) && sameText(readFileSync(tasksFile, 'utf8'), readTemplate(templatesDir, 'tasks.json'))) {
    problems.push(`${ralphDir}/tasks.json is still the template`);
    return problems;
  }

  let tasks;
  try {
    tasks = new TaskStore(tasksFile).readTasks();
  } catch (cause) {
    problems.push((cause as Error).message);
    return problems;
  }
  if (tasks.length === 0) problems.push(`${ralphDir}/tasks.json has no tasks`);

  const seen = new Set<string>();
  for (const task of tasks) {
    const label = `task ${task.id}`;
    if (!TASK_ID.test(task.id)) problems.push(`${label}: id must look like TASK-1`);
    if (seen.has(task.id)) problems.push(`${label}: duplicate id`);
    seen.add(task.id);
    if (!task.title.trim()) problems.push(`${label}: title is empty`);
    if (task.passes && !options.replan) problems.push(`${label}: a new task must have "passes": false`);

    if (!task.specFilePath) {
      problems.push(`${label}: specFilePath is missing`);
      continue;
    }
    problems.push(
      ...checkSpec(resolve(projectRoot, task.specFilePath), task.specFilePath, task.id, readTemplate(templatesDir, 'TASK-1.json')),
    );
  }

  return problems;
}

function checkSpec(path: string, shown: string, taskId: string, template: string): string[] {
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
  if (id !== taskId) problems.push(`${label}: spec ${shown} has id ${JSON.stringify(id)}, expected "${taskId}"`);
  if (
    !Array.isArray(acceptanceCriteria) ||
    acceptanceCriteria.length === 0 ||
    !acceptanceCriteria.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    problems.push(`${label}: spec ${shown} needs a non-empty acceptanceCriteria list of strings`);
  }
  return problems;
}

function readTemplate(templatesDir: string, name: string): string {
  return readFileSync(resolve(templatesDir, name), 'utf8');
}

function sameText(a: string, b: string): boolean {
  const normalise = (text: string) => text.replace(/\r\n/g, '\n').trim();
  return normalise(a) === normalise(b);
}
