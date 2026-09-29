import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskStore } from '../tasks/store.js';

const run = promisify(execFile);

export interface RepoSnapshot {
  head: string | null;
  dirtyFiles: number;
  tasksPassed: number;
}

export interface ProgressDelta {
  committed: boolean;
  tasksPassedDelta: number;
  filesChanged: number;
  /** True when the repository shows the agent actually did something. */
  productive: boolean;
}

/**
 * Snapshot the facts the loop uses to verify the agent's claims: what the
 * agent says it did matters less than what the repository shows.
 */
export async function snapshotRepo(cwd: string, tasks: TaskStore): Promise<RepoSnapshot> {
  return {
    head: await gitHead(cwd),
    dirtyFiles: await gitDirtyCount(cwd),
    tasksPassed: tasks.reload().passedCount,
  };
}

export function diffSnapshots(before: RepoSnapshot, after: RepoSnapshot): ProgressDelta {
  const committed = before.head !== after.head;
  const tasksPassedDelta = after.tasksPassed - before.tasksPassed;
  const filesChanged = Math.abs(after.dirtyFiles - before.dirtyFiles);
  return {
    committed,
    tasksPassedDelta,
    filesChanged,
    productive: committed || tasksPassedDelta > 0 || filesChanged > 0,
  };
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    // No commits yet: a valid starting state, not an error.
    return null;
  }
}

async function gitDirtyCount(cwd: string): Promise<number> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd });
    return stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}
