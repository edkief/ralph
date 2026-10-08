import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

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

/** tasks.json is a bare array; tolerate a `{ tasks: [...] }` wrapper too. */
const TasksFileSchema = z.union([
  z.array(TaskSchema),
  z.looseObject({ tasks: z.array(TaskSchema) }).transform((value) => value.tasks),
]);

export class TaskStoreError extends Error {}

export interface TaskSummary {
  total: number;
  passedCount: number;
  next: Task | undefined;
}

/**
 * Reads `.ralph/tasks.json` fresh on demand. The agent edits the file between
 * iterations, so nothing is cached across an iteration boundary.
 */
export class TaskStore {
  constructor(private readonly tasksFile: string) {}

  static forProject(projectRoot: string, ralphDir: string): TaskStore {
    return new TaskStore(resolve(projectRoot, ralphDir, 'tasks.json'));
  }

  get path(): string {
    return this.tasksFile;
  }

  exists(): boolean {
    return existsSync(this.tasksFile);
  }

  /** Re-read and validate the file, returning task counts and the next task. */
  reload(): TaskSummary {
    const tasks = this.readTasks();
    return {
      total: tasks.length,
      passedCount: tasks.filter((task) => task.passes).length,
      next: tasks.find((task) => !task.passes),
    };
  }

  readTasks(): Task[] {
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

  /**
   * Set one task's `passes` flag on disk, leaving everything else in the file
   * as it was: the wrapper, if any, and fields Ralph does not know. Whether
   * the task was found.
   */
  setPasses(taskId: string, passes: boolean): boolean {
    this.readTasks();
    const raw = JSON.parse(readFileSync(this.tasksFile, 'utf8')) as unknown;
    const list = (Array.isArray(raw) ? raw : (raw as { tasks: unknown[] }).tasks) as Array<Record<string, unknown>>;
    const task = list.find((entry) => entry['id'] === taskId);
    if (!task) return false;
    task['passes'] = passes;
    writeFileSync(this.tasksFile, `${JSON.stringify(raw, null, 2)}\n`);
    return true;
  }

  /** True when the agent's claimed task really is marked passing on disk. */
  isPassing(taskId: string): boolean {
    return this.readTasks().some((task) => task.id === taskId && task.passes);
  }
}
