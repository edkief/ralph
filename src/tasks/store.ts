import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const TaskSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(''),
  category: z.string().optional(),
  specFilePath: z.string().optional(),
  passes: z.boolean().default(false),
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
 * Reads `.agent/tasks.json` fresh on demand. The agent edits the file between
 * iterations, so nothing is cached across an iteration boundary.
 */
export class TaskStore {
  constructor(private readonly tasksFile: string) {}

  static forProject(projectRoot: string, agentDir: string): TaskStore {
    return new TaskStore(resolve(projectRoot, agentDir, 'tasks.json'));
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

  /** True when the agent's claimed task really is marked passing on disk. */
  isPassing(taskId: string): boolean {
    return this.readTasks().some((task) => task.id === taskId && task.passes);
  }
}
