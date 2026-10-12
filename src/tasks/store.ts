import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readSplitRecords } from './splits.js';

/** Must match the loop's `<promise>TASK-x:DONE</promise>` tag, or progress is never recognised. */
export const TASK_ID = /^TASK-[A-Za-z0-9._-]+$/;

const TaskSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(''),
  category: z.string().optional(),
  specFilePath: z.string().optional(),
  passes: z.boolean().default(false),
  /** The task this one was split from, when Ralph split a task that kept running out of time. */
  splitFrom: z.string().optional(),
  /** How many splits separate this task from the plan's original task. */
  splitDepth: z.number().int().min(0).optional(),
});

export type Task = z.infer<typeof TaskSchema>;

/**
 * tasks.json is a bare array of entries, an id and whether it passes, in run
 * order; tolerate a `{ tasks: [...] }` wrapper too. Entries written before the
 * spec became the only source of a task may still carry its title and the
 * rest; those count only where the spec does not say.
 */
const TasksFileSchema = z.union([
  z.array(TaskSchema),
  z.looseObject({ tasks: z.array(TaskSchema) }).transform((value) => value.tasks),
]);

/** What a spec may say about its task besides what it asks for. */
const SpecSchema = z.looseObject({
  id: z.unknown().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
  splitFrom: z.string().optional(),
  splitDepth: z.number().int().min(0).optional(),
});

export class TaskStoreError extends Error {}

export interface TaskSummary {
  total: number;
  passedCount: number;
  next: Task | undefined;
}

/** The backlog, and where tasks.json and the specs disagree. */
export interface TaskInspection {
  /** Listed tasks in list order, then specs the list leaves out, by id. */
  tasks: Task[];
  /** Ids with a spec in the tasks folder but no entry in tasks.json; they run after the listed ones. */
  unlisted: string[];
  /** Entries in tasks.json with no spec to read. */
  missingSpec: Array<{ id: string; passes: boolean }>;
  /** Specs in the tasks folder for tasks that were split: not tasks any more, and never run. */
  leftBehind: string[];
  /** Specs whose `id` is not the id their file name gives. */
  idMismatch: Array<{ id: string; specId: unknown }>;
}

/**
 * The backlog: `.ralph/tasks.json` holds each task's status, in run order, and
 * its spec, `.ralph/tasks/<id>.json`, everything else. A spec the list leaves
 * out still runs, after the listed tasks. Read fresh on demand: the agent edits
 * these files between iterations, so nothing is cached across an iteration
 * boundary.
 */
export class TaskStore {
  private readonly ralphPath: string;
  private readonly specsDir: string;

  /** `projectRoot` defaults to the folder above the Ralph folder, as with `.ralph/tasks.json`. */
  constructor(
    private readonly tasksFile: string,
    private readonly projectRoot = dirname(dirname(tasksFile)),
  ) {
    this.ralphPath = dirname(tasksFile);
    this.specsDir = resolve(this.ralphPath, 'tasks');
  }

  static forProject(projectRoot: string, ralphDir: string): TaskStore {
    return new TaskStore(resolve(projectRoot, ralphDir, 'tasks.json'), resolve(projectRoot));
  }

  get path(): string {
    return this.tasksFile;
  }

  exists(): boolean {
    return existsSync(this.tasksFile);
  }

  /** Re-read and validate the backlog, returning task counts and the next task. */
  reload(): TaskSummary {
    const tasks = this.readTasks();
    return {
      total: tasks.length,
      passedCount: tasks.filter((task) => task.passes).length,
      next: tasks.find((task) => !task.passes),
    };
  }

  readTasks(): Task[] {
    return this.inspect().tasks;
  }

  inspect(): TaskInspection {
    const entries = this.readEntries();
    const projectRoot = this.projectRoot;
    const inspection: TaskInspection = { tasks: [], unlisted: [], missingSpec: [], leftBehind: [], idMismatch: [] };

    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);

      const conventional = resolve(this.specsDir, `${entry.id}.json`);
      const legacy = entry.specFilePath ? resolve(projectRoot, entry.specFilePath) : undefined;
      const specFile = existsSync(conventional) ? conventional : legacy && existsSync(legacy) ? legacy : undefined;
      if (!specFile) {
        inspection.missingSpec.push({ id: entry.id, passes: entry.passes });
        inspection.tasks.push(entry);
        continue;
      }
      const spec = readSpec(specFile);
      if (spec && spec.id !== entry.id) inspection.idMismatch.push({ id: entry.id, specId: spec.id });
      inspection.tasks.push(merge(entry, spec, this.shown(specFile)));
    }

    const splitIds = new Set(readSplitRecords(projectRoot, relative(projectRoot, this.ralphPath)).map((record) => record.taskId));
    const files = existsSync(this.specsDir) ? readdirSync(this.specsDir).filter((file) => file.endsWith('.json')) : [];
    const unlisted = files
      .map((file) => file.slice(0, -'.json'.length))
      .filter((id) => TASK_ID.test(id) && !seen.has(id))
      .sort(compareIds);
    for (const id of unlisted) {
      if (splitIds.has(id)) {
        inspection.leftBehind.push(id);
        continue;
      }
      const specFile = resolve(this.specsDir, `${id}.json`);
      const spec = readSpec(specFile);
      if (spec && spec.id !== id) inspection.idMismatch.push({ id, specId: spec.id });
      inspection.unlisted.push(id);
      inspection.tasks.push(merge({ id, title: '', passes: false }, spec, this.shown(specFile)));
    }
    return inspection;
  }

  /**
   * Set one task's `passes` flag on disk, leaving everything else in the file
   * as it was: the wrapper, if any, and fields Ralph does not know. A task
   * with a spec but no entry gets one, at the end of the list. Whether the
   * task was found.
   */
  setPasses(taskId: string, passes: boolean): boolean {
    const tasks = this.readTasks();
    const raw = JSON.parse(readFileSync(this.tasksFile, 'utf8')) as unknown;
    const list = (Array.isArray(raw) ? raw : (raw as { tasks: unknown[] }).tasks) as Array<Record<string, unknown>>;
    const task = list.find((entry) => entry['id'] === taskId);
    if (task) {
      task['passes'] = passes;
    } else if (tasks.some((candidate) => candidate.id === taskId)) {
      list.push({ id: taskId, passes });
    } else {
      return false;
    }
    writeFileSync(this.tasksFile, `${JSON.stringify(raw, null, 2)}\n`);
    return true;
  }

  /** True when the agent's claimed task really is marked passing on disk. */
  isPassing(taskId: string): boolean {
    return this.readTasks().some((task) => task.id === taskId && task.passes);
  }

  private readEntries(): Task[] {
    if (!existsSync(this.tasksFile)) {
      throw new TaskStoreError(`Task list not found: ${this.tasksFile}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.tasksFile, 'utf8'));
    } catch (cause) {
      throw new TaskStoreError(`${this.tasksFile} is not valid JSON: ${(cause as Error).message}`);
    }

    const parsed = TasksFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TaskStoreError(
        `${this.tasksFile} does not match the expected task shape:\n${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  /** A spec's path as tasks show it: relative to the project root, with forward slashes. */
  private shown(path: string): string {
    return relative(this.projectRoot, path).split(sep).join('/');
  }
}

/** The task as its spec describes it; the entry's own copy fills in only what the spec does not say. */
function merge(entry: Task, spec: z.infer<typeof SpecSchema> | undefined, specFilePath: string): Task {
  const task: Task = { ...entry, specFilePath };
  if (!spec) return task;
  if (spec.title !== undefined) task.title = spec.title;
  for (const key of ['category', 'splitFrom', 'splitDepth'] as const) {
    if (spec[key] !== undefined) (task as Record<string, unknown>)[key] = spec[key];
  }
  return task;
}

/** A spec's fields, or nothing when it does not read: plan checks and `ralph doctor` report that. */
function readSpec(path: string): z.infer<typeof SpecSchema> | undefined {
  try {
    const parsed = SpecSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Ids in natural order: `TASK-7` before `TASK-7.1` before `TASK-10`. */
export function compareIds(a: string, b: string): number {
  const parts = (id: string) => id.replace(/^TASK-/, '').split(/[.]/);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const order = left[i]!.localeCompare(right[i]!, 'en', { numeric: true });
    if (order !== 0) return order;
  }
  return 0;
}
