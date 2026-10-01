import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, relative, resolve, sep } from 'node:path';
import { TaskStore } from '../tasks/store.js';
import { TASK_ID } from '../init/plan.js';
import { actionsFor, readAnswer, readPending, type PendingState } from '../human/request.js';
import { parseJsonLines } from './tail.js';
import { TranscriptBuilder } from './transcript.js';
import type { IterationRecord, RunState, SplitRecord } from '../report/jsonl.js';
import type { OpencodeEvent } from '../opencode/events.js';
import type {
  FileContent,
  FileEntry,
  IterationView,
  LogLine,
  PendingView,
  RunDetail,
  RunView,
  SplitView,
  StatusView,
  TasksView,
  TranscriptEntry,
} from './types.js';

/** File content returned whole; beyond this only the start is. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Files listed at most, so a stray node_modules cannot flood the browser. */
const MAX_FILES = 2000;
/** Log lines returned at most, the latest. */
export const MAX_LOG_LINES = 5000;
/**
 * A running run on another host (a sidecar, another pod) whose files have not
 * changed for this long is taken to have died. Iterations are quiet between
 * events for at most the inactivity timeout, which defaults to 3 minutes.
 */
const STALE_MS = 15 * 60_000;

const RUN_ID = /^[\w.-]+$/;
const EVENTS_FILE = /^iteration-(\d+)\.events\.jsonl$/;

export class NotFoundError extends Error {}

/**
 * Reads what the web UI shows from the project's Ralph folder. Everything
 * comes from disk, so it works the same beside the loop, in another process,
 * or after the run has ended. Nothing here writes.
 */
export class RalphProject {
  readonly ralphRoot: string;
  readonly historyRoot: string;

  constructor(
    readonly projectRoot: string,
    readonly ralphDir: string,
  ) {
    this.ralphRoot = resolve(projectRoot, ralphDir);
    this.historyRoot = resolve(this.ralphRoot, 'history');
  }

  status(): StatusView {
    const latest = this.listRuns()[0];
    return {
      project: basename(resolve(this.projectRoot)),
      projectRoot: resolve(this.projectRoot),
      ralphDir: this.ralphDir,
      tasks: this.tasks(),
      run: latest ?? null,
      pending: this.pendingView(),
    };
  }

  /** The request waiting for a person, if any, and what can be done about it right now. */
  pending(): PendingState | undefined {
    const pending = readPending(this.ralphRoot);
    if (!pending) return undefined;
    let waiting = false;
    try {
      const run = this.run(pending.runId);
      waiting = pending.waiting && run.status === 'waiting' && run.live;
    } catch {
      // Its run is gone: nothing waits.
    }
    return {
      pending,
      waiting,
      answered: readAnswer(this.ralphRoot)?.id === pending.id,
      actions: actionsFor(pending.kind, waiting),
    };
  }

  private pendingView(): PendingView | null {
    const state = this.pending();
    if (!state) return null;
    const { pending } = state;
    return {
      id: pending.id,
      runId: pending.runId,
      kind: pending.kind,
      taskId: pending.taskId,
      message: pending.message,
      ...(pending.question ? { question: pending.question } : {}),
      ...(pending.split ? { split: pending.split } : {}),
      waiting: state.waiting,
      answered: state.answered,
      actions: state.actions,
      createdAt: pending.createdAt,
    };
  }

  tasks(): TasksView {
    const store = TaskStore.forProject(this.projectRoot, this.ralphDir);
    if (!store.exists()) return { total: 0, passed: 0, next: null, items: [], error: 'tasks.json not found' };
    try {
      const items = store.readTasks().map((task) => ({
        id: task.id,
        title: task.title,
        passes: task.passes,
        ...(task.category ? { category: task.category } : {}),
        ...(task.specFilePath ? { specFilePath: task.specFilePath } : {}),
        ...(task.splitFrom ? { splitFrom: task.splitFrom } : {}),
      }));
      return {
        total: items.length,
        passed: items.filter((task) => task.passes).length,
        next: items.find((task) => !task.passes)?.id ?? null,
        items,
      };
    } catch (cause) {
      return { total: 0, passed: 0, next: null, items: [], error: (cause as Error).message };
    }
  }

  /** Runs, newest first. Run ids are timestamps, so they sort by name. */
  listRuns(): RunView[] {
    if (!existsSync(this.historyRoot)) return [];
    return readdirSync(this.historyRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .map((runId) => this.run(runId));
  }

  run(runId: string): RunView {
    const dir = this.runDir(runId);
    const state = readJson<RunState>(resolve(dir, 'state.json'));
    const summary = readJson<{ status?: string; iterations?: number; tasksPassed?: number; tasksTotal?: number; message?: string }>(
      resolve(dir, 'run.json'),
    );
    const latest = this.latestIteration(runId);

    if (state) {
      return {
        runId,
        status: state.status,
        live: (state.status === 'running' || state.status === 'waiting') && this.isAlive(state, dir),
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        maxIterations: state.maxIterations,
        iteration: state.iteration,
        taskId: state.taskId,
        iterationStartedAt: state.iterationStartedAt,
        lastStatus: state.lastStatus,
        tasksPassed: state.tasksPassed,
        tasksTotal: state.tasksTotal,
        split: state.split ?? null,
        ...(state.message ? { message: state.message } : {}),
      };
    }

    // A run from before state.json: only its summary and files say anything.
    return {
      runId,
      status: summary?.status ?? 'unknown',
      live: false,
      startedAt: null,
      updatedAt: null,
      maxIterations: null,
      iteration: summary?.iterations ?? latest,
      taskId: null,
      iterationStartedAt: null,
      lastStatus: null,
      tasksPassed: summary?.tasksPassed ?? null,
      tasksTotal: summary?.tasksTotal ?? null,
      split: null,
      ...(summary?.message ? { message: summary.message } : {}),
    };
  }

  runDetail(runId: string): RunDetail {
    const run = this.run(runId);
    const records = parseJsonLines<IterationRecord>(readLines(resolve(this.runDir(runId), 'iterations.jsonl')));
    // A retried iteration is recorded once, but keep the last record if not.
    const byIteration = new Map<number, IterationView>();
    for (const record of records) byIteration.set(record.iteration, iterationView(record));

    const latest = this.latestIteration(runId);
    if (run.live && latest > 0 && !byIteration.has(latest)) {
      byIteration.set(latest, {
        iteration: latest,
        taskId: run.iteration === latest ? run.taskId : null,
        status: 'running',
        startedAt: run.iteration === latest ? run.iterationStartedAt : null,
        endedAt: null,
        durationMs: null,
        toolCalls: null,
        tokens: null,
        committed: false,
        tasksPassedDelta: 0,
        compactions: 0,
      });
    }
    return {
      run,
      iterations: [...byIteration.values()].sort((a, b) => a.iteration - b.iteration),
      splits: this.splits(run),
    };
  }

  /** The run's split turns: those recorded, and the one still running or cut off before its record. */
  private splits(run: RunView): SplitView[] {
    const dir = this.runDir(run.runId);
    const splits = parseJsonLines<SplitRecord>(readLines(resolve(dir, 'splits.jsonl'))).map(splitView);
    const open = run.split;
    if (open && !splits.some((split) => split.taskId === open.taskId) && existsSync(this.splitEventsPath(run.runId, open.taskId))) {
      splits.push({
        taskId: open.taskId,
        iteration: run.iteration,
        status: run.live ? 'running' : 'ended',
        startedAt: open.startedAt,
        endedAt: null,
        durationMs: null,
      });
    }
    return splits;
  }

  log(runId: string): LogLine[] {
    return parseJsonLines<LogLine>(readLines(this.logPath(runId))).slice(-MAX_LOG_LINES);
  }

  transcript(runId: string, iteration: number): TranscriptEntry[] {
    const path = this.eventsPath(runId, iteration);
    if (!existsSync(path)) throw new NotFoundError(`No events for iteration ${iteration} of run ${runId}`);
    return transcriptOf(path);
  }

  /** The transcript of the turn that proposed splitting `taskId`. */
  splitTranscript(runId: string, taskId: string): TranscriptEntry[] {
    const path = this.splitEventsPath(runId, taskId);
    if (!existsSync(path)) throw new NotFoundError(`No split of ${taskId} in run ${runId}`);
    return transcriptOf(path);
  }

  /** The highest iteration with an event file, 0 before the first. */
  latestIteration(runId: string): number {
    let latest = 0;
    for (const name of safeReaddir(this.runDir(runId))) {
      const match = EVENTS_FILE.exec(name);
      if (match) latest = Math.max(latest, Number(match[1]));
    }
    return latest;
  }

  runDir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new NotFoundError(`No run ${runId}`);
    const dir = resolve(this.historyRoot, runId);
    if (!existsSync(dir)) throw new NotFoundError(`No run ${runId}`);
    return dir;
  }

  logPath(runId: string): string {
    return resolve(this.runDir(runId), 'log.jsonl');
  }

  eventsPath(runId: string, iteration: number): string {
    return resolve(this.runDir(runId), `iteration-${String(iteration).padStart(3, '0')}.events.jsonl`);
  }

  splitEventsPath(runId: string, taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new NotFoundError(`No task ${taskId}`);
    return resolve(this.runDir(runId), `split-${taskId}.events.jsonl`);
  }

  /**
   * The Ralph folder's files, without its history (which the UI shows as
   * runs), plus the project's ralph.config.json.
   */
  listFiles(): FileEntry[] {
    const files: FileEntry[] = [];
    const visit = (dir: string) => {
      for (const entry of safeReaddir(dir).sort()) {
        if (files.length >= MAX_FILES) return;
        const path = resolve(dir, entry);
        if (path === this.historyRoot) continue;
        const target = this.inside(path);
        if (!target) continue;
        const stat = statSync(target, { throwIfNoEntry: false });
        if (stat?.isDirectory()) visit(path);
        else if (stat?.isFile()) files.push(this.entry(path, stat));
      }
    };
    visit(this.ralphRoot);

    const config = resolve(this.projectRoot, 'ralph.config.json');
    const stat = statSync(config, { throwIfNoEntry: false });
    if (stat?.isFile()) files.push(this.entry(config, stat));
    return files;
  }

  /** A listed file's content. Anything else, and anything under history/, is not found. */
  readFile(path: string): FileContent {
    const listed = this.listFiles().find((file) => file.path === path);
    if (!listed) throw new NotFoundError(`No file ${path}`);
    const absolute = resolve(this.projectRoot, path);
    const size = statSync(absolute).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    const fd = openSync(absolute, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    return { ...listed, content: buffer.toString('utf8'), truncated: size > MAX_FILE_BYTES };
  }

  private entry(path: string, stat: { size: number; mtime: Date }): FileEntry {
    return {
      path: relative(this.projectRoot, path).split(sep).join('/'),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  /** The real path of `path` when it (through any symlink) stays inside the Ralph folder. */
  private inside(path: string): string | undefined {
    try {
      if (!lstatSync(path).isSymbolicLink()) return path;
      const real = realpathSync(path);
      const root = realpathSync(this.ralphRoot);
      return real === root || real.startsWith(root + sep) ? real : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a run that says it is running still is. On this host its pid
   * answers that; elsewhere, whether its files are still changing.
   */
  private isAlive(state: RunState, dir: string): boolean {
    if (state.hostname === hostname()) {
      try {
        process.kill(state.pid, 0);
        return true;
      } catch (cause) {
        return (cause as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    const touched = safeReaddir(dir).map((name) => statSync(resolve(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0);
    return Date.now() - Math.max(0, ...touched) < STALE_MS;
  }
}

function iterationView(record: IterationRecord): IterationView {
  const { result, delta } = record;
  return {
    iteration: record.iteration,
    taskId: record.taskId,
    status: delta.productive || result.status !== 'progressed' ? result.status : 'no-progress',
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: result.durationMs,
    toolCalls: result.toolCalls,
    tokens: result.usage.input + result.usage.output,
    committed: delta.committed,
    tasksPassedDelta: delta.tasksPassedDelta,
    compactions: result.compactions ?? 0,
    ...(record.handoff ? { handoff: record.handoff } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function splitView(record: SplitRecord): SplitView {
  const durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
  return {
    taskId: record.taskId,
    iteration: record.iteration,
    status: record.status,
    ...(record.children ? { children: record.children } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
  };
}

function transcriptOf(path: string): TranscriptEntry[] {
  const builder = new TranscriptBuilder();
  for (const event of parseJsonLines<OpencodeEvent>(readLines(path))) builder.push(event);
  return builder.all;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
