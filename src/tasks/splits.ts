import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Where a task's split is proposed and, once applied, archived; relative to the project root. */
export function splitDir(ralphDir: string, taskId: string): string {
  return `${ralphDir.replace(/\/+$/, '')}/split/${taskId}`;
}

/**
 * A task that was split, as its split record tells it: the task is gone from
 * tasks.json, and this is what is left of it.
 */
export interface SplitRecord {
  taskId: string;
  /** Null for a record written before Ralph kept the title, with no archived spec to read it from. */
  title: string | null;
  /** The task's archived spec, relative to the project root. */
  specFilePath?: string;
  /** The handoff its last attempt left, archived; relative to the project root. */
  handoffPath?: string;
  children: Array<{ id: string; title: string }>;
  appliedAt: string;
}

/** A task a task was split from, nearest first, with how far the tasks it was split into have got. */
export interface SplitAncestor {
  id: string;
  title: string | null;
  specFilePath?: string;
  handoffPath?: string;
  /** `passes` is null for a task no longer in tasks.json: split again. */
  children: Array<{ id: string; title: string; passes: boolean | null }>;
}

const AppliedSchema = z.looseObject({
  task: z.string(),
  splittable: z.literal(true),
  tasks: z.array(z.looseObject({ id: z.string(), title: z.string() })),
  appliedAt: z.string(),
  parent: z
    .looseObject({ title: z.string().optional(), specFilePath: z.string().optional(), handoffPath: z.string().optional() })
    .optional(),
});

const SpecTitleSchema = z.looseObject({ title: z.string() });

/**
 * Every applied split in the project's split folder. A record written before
 * Ralph kept the split task's title and archive in it has them worked out
 * from the archived files. Proposals not applied, and files that do not read,
 * are left out.
 */
export function readSplitRecords(projectRoot: string, ralphDir: string): SplitRecord[] {
  const root = resolve(projectRoot, ralphDir, 'split');
  if (!existsSync(root)) return [];
  const records: SplitRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = splitDir(ralphDir, entry.name);
    const parsed = AppliedSchema.safeParse(readJson(resolve(projectRoot, dir, 'proposal.json')));
    if (!parsed.success || parsed.data.task !== entry.name) continue;
    const { task, tasks, appliedAt, parent } = parsed.data;

    const archivedSpec = `${dir}/${task}.json`;
    const archivedHandoff = `${dir}/handoff.md`;
    const specFilePath = parent?.specFilePath ?? (existsSync(resolve(projectRoot, archivedSpec)) ? archivedSpec : undefined);
    const handoffPath = parent?.handoffPath ?? (existsSync(resolve(projectRoot, archivedHandoff)) ? archivedHandoff : undefined);
    const specTitle = specFilePath ? SpecTitleSchema.safeParse(readJson(resolve(projectRoot, specFilePath))) : undefined;
    records.push({
      taskId: task,
      title: parent?.title ?? (specTitle?.success ? specTitle.data.title : null),
      ...(specFilePath ? { specFilePath } : {}),
      ...(handoffPath ? { handoffPath } : {}),
      children: tasks.map((child) => ({ id: child.id, title: child.title })),
      appliedAt,
    });
  }
  return records;
}

/**
 * The tasks `taskId` was split from, nearest first: its `splitFrom`, then
 * whichever split listed that one, and so on. Only tasks with a split record
 * are listed, so the chain stops at the first one without.
 */
export function splitLineage(
  records: SplitRecord[],
  tasks: Array<{ id: string; title: string; passes: boolean; splitFrom?: string | undefined }>,
  taskId: string,
): SplitAncestor[] {
  const byTask = new Map(records.map((record) => [record.taskId, record]));
  const listed = new Map(tasks.map((task) => [task.id, task]));
  const parentOf = (id: string): string | undefined =>
    listed.get(id)?.splitFrom ?? records.find((record) => record.children.some((child) => child.id === id))?.taskId;

  const lineage: SplitAncestor[] = [];
  const seen = new Set([taskId]);
  for (let parent = parentOf(taskId); parent && !seen.has(parent); parent = parentOf(parent)) {
    seen.add(parent);
    const record = byTask.get(parent);
    if (!record) break;
    lineage.push({
      id: record.taskId,
      title: record.title,
      ...(record.specFilePath ? { specFilePath: record.specFilePath } : {}),
      ...(record.handoffPath ? { handoffPath: record.handoffPath } : {}),
      children: record.children.map((child) => {
        const task = listed.get(child.id);
        return { id: child.id, title: task?.title || child.title, passes: task ? task.passes : null };
      }),
    });
  }
  return lineage;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
