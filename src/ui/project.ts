import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { TaskStore } from '../tasks/store.js';
import { TASK_ID } from '../init/plan.js';
import { actionsFor, readAnswer, readPending, type PendingState } from '../human/request.js';
import { daemonLive, readDaemonState } from '../daemon/control.js';
import { LineTailer, parseJsonLines } from './tail.js';
import { readJournalTranscript } from '../report/journal.js';
import { TranscriptBuilder } from './transcript.js';
import type { IterationRecord, RunState, SplitRecord } from '../report/jsonl.js';
import type { OpencodeEvent } from '../opencode/events.js';
import { aggregateMetrics, type TaskInput, type TurnInput } from '../metrics/aggregate.js';
import { UNKNOWN_MODEL, usageOfEventsFile, type TurnUsage } from '../metrics/usage.js';
import type { CostEstimator } from '../metrics/cost.js';
import type {
  DaemonView,
  FileContent,
  FileEntry,
  IterationView,
  LogLine,
  MetricsView,
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
/** Files shown as a picture rather than as text, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
/** Files listed at most, so a stray node_modules cannot flood the browser. */
const MAX_FILES = 2000;
/** Log lines returned at most, the latest. */
export const MAX_LOG_LINES = 5000;
/** How much of the end of a log file is read to find them. */
export const LOG_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * A running run on another host (a sidecar, another pod) whose files have not
 * changed for this long is taken to have died. Iterations are quiet between
 * events for at most the inactivity timeout, which defaults to 3 minutes.
 */
const STALE_MS = 15 * 60_000;

const RUN_ID = /^[\w.-]+$/;
/** A run id as `newRunId` makes it: the start in the local time of the machine that ran it. */
const RUN_ID_TIME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/;
const EVENTS_FILE = /^iteration-(\d+)\.(?:events|transcript)\.jsonl$/;

export class NotFoundError extends Error {}

function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extname(path).toLowerCase()];
}

/**
 * Reads what the web UI shows from the project's Ralph folder. Everything
 * comes from disk, so it works the same beside the loop, in another process,
 * or after the run has ended. Nothing here writes.
 */
export class RalphProject {
  readonly ralphRoot: string;
  readonly historyRoot: string;
  /** Runs as committed, for those whose history is on another machine. */
  readonly journalRoot: string;
  /** When each run started, once its state says so: that never changes. */
  private readonly startTimes = new Map<string, number>();
  /** Usage worked out from the event file of a turn recorded before usage was, by path. */
  private readonly backfills = new Map<string, { mtimeMs: number; size: number; usage: TurnUsage }>();

  constructor(
    readonly projectRoot: string,
    readonly ralphDir: string,
  ) {
    this.ralphRoot = resolve(projectRoot, ralphDir);
    this.historyRoot = resolve(this.ralphRoot, 'history');
    this.journalRoot = resolve(this.ralphRoot, 'journal');
  }

  status(): StatusView {
    // Only the newest run: this is read on every live tick, and history grows.
    const latest = this.runIds()[0];
    return {
      project: basename(resolve(this.projectRoot)),
      projectRoot: resolve(this.projectRoot),
      ralphDir: this.ralphDir,
      tasks: this.tasks(),
      run: latest ? this.run(latest) : null,
      pending: this.pendingView(),
      daemon: this.daemon(),
    };
  }

  /** The project's daemon, without its heartbeat, so a live view changes only when it does. */
  daemon(): DaemonView | null {
    const state = readDaemonState(this.ralphRoot);
    if (!state) return null;
    const live = daemonLive(state);
    return {
      live,
      status: live ? state.status : 'stopped',
      pid: state.pid,
      hostname: state.hostname,
      startedAt: state.startedAt,
      defaultIterations: state.defaultIterations,
      batch: live ? state.batch : null,
      lastBatch: state.lastBatch ?? null,
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

  /** Runs, newest first. */
  listRuns(): RunView[] {
    return this.runIds().map((runId) => this.run(runId));
  }

  /** Runs in the history and in the journal, which has those run elsewhere. */
  private runIds(): string[] {
    const ids = new Set<string>();
    for (const root of [this.historyRoot, this.journalRoot]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && RUN_ID.test(entry.name)) ids.add(entry.name);
      }
    }
    // By when they started, not by id: an id is in the local time of the
    // machine that ran it, so runs from machines in other time zones (a UTC
    // container beside a laptop, a journal pulled from elsewhere) misorder.
    const starts = new Map([...ids].map((id) => [id, this.startTime(id)]));
    return [...ids].sort((a, b) => starts.get(b)! - starts.get(a)! || (a < b ? 1 : a > b ? -1 : 0));
  }

  /** When a run started, from its state, or else from its id; 0 when neither says. */
  private startTime(runId: string): number {
    const known = this.startTimes.get(runId);
    if (known !== undefined) return known;
    const startedAt = Date.parse(readJson<RunState>(resolve(this.runDir(runId), 'state.json'))?.startedAt ?? '');
    if (Number.isFinite(startedAt)) {
      this.startTimes.set(runId, startedAt);
      return startedAt;
    }
    // A run from before state.json, or one whose state is not written yet.
    const parts = RUN_ID_TIME.exec(runId);
    if (!parts) return 0;
    const [year, month, day, hours, minutes, seconds] = parts.slice(1).map(Number) as [number, number, number, number, number, number];
    return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
  }

  /** Whether all there is of a run is its journal: it ran on another machine, or its history was removed. */
  private journalOnly(runId: string): boolean {
    return !existsSync(resolve(this.historyRoot, runId));
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
        live:
          (state.status === 'running' || state.status === 'waiting') && !this.journalOnly(runId) && this.isAlive(state, dir),
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
        ...(open.phase === 'assess' ? { trigger: 'assessment' as const } : {}),
        status: run.live ? 'running' : 'ended',
        startedAt: open.startedAt,
        endedAt: null,
        durationMs: null,
      });
    }
    return splits;
  }

  /**
   * The project's metrics, over every finished turn of every run. A turn
   * recorded before usage was has it worked out from its event file, where
   * this machine still has one; else only its record's totals count, under an
   * unknown model, with its wall-clock time standing in for inference time.
   */
  metrics(cost: { estimator: CostEstimator | undefined; currency: string }): MetricsView {
    const runs = this.runIds().map((runId) => this.run(runId));
    const turns: TurnInput[] = [];
    const splits: Array<{ taskId: string; children: string[] }> = [];

    for (const run of runs) {
      const dir = this.runDir(run.runId);
      const history = resolve(this.historyRoot, run.runId);
      const byIteration = new Map<number, IterationRecord>();
      for (const record of parseJsonLines<IterationRecord>(readLines(resolve(dir, 'iterations.jsonl')))) {
        byIteration.set(record.iteration, record);
      }
      for (const record of byIteration.values()) {
        const events = resolve(history, `iteration-${String(record.iteration).padStart(3, '0')}.events.jsonl`);
        const usage = record.models
          ? { usage: record.models, source: 'recorded' as const }
          : this.backfill(events) ?? { usage: legacyUsage(record), source: 'legacy' as const };
        turns.push({
          runId: run.runId,
          kind: 'iteration',
          iteration: record.iteration,
          taskId: record.taskId,
          startedAt: record.startedAt ?? null,
          wallMs: record.result?.durationMs ?? null,
          ...usage,
        });
      }

      const records = parseJsonLines<SplitRecord>(readLines(resolve(dir, 'splits.jsonl')));
      records.forEach((record, index) => {
        if (record.status === 'applied' && record.children) splits.push({ taskId: record.taskId, children: record.children });
        // A task's event file holds only its last turn in the run: each one starts it over.
        const last = !records.slice(index + 1).some((later) => later.taskId === record.taskId);
        const backfilled = !record.models && last ? this.backfill(resolve(history, `split-${record.taskId}.events.jsonl`)) : undefined;
        const usage = record.models
          ? { usage: record.models, source: 'recorded' as const }
          : backfilled ?? { usage: {}, source: 'none' as const };
        const wallMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
        turns.push({
          runId: run.runId,
          kind: record.trigger === 'assessment' && (record.status === 'fits' || record.estimateMinutes === undefined) ? 'assessment' : 'split',
          iteration: record.iteration,
          taskId: record.taskId,
          startedAt: record.startedAt ?? null,
          wallMs: Number.isFinite(wallMs) ? wallMs : null,
          ...usage,
        });
      });
    }

    let tasks: TaskInput[] = [];
    try {
      tasks = TaskStore.forProject(this.projectRoot, this.ralphDir)
        .readTasks()
        .map((task) => ({ id: task.id, title: task.title, passes: task.passes, ...(task.splitFrom ? { splitFrom: task.splitFrom } : {}) }));
    } catch {
      // No backlog to read: tasks show by id only.
    }
    return aggregateMetrics({
      runs: runs.map((run) => ({ runId: run.runId, status: run.status, startedAt: run.startedAt })),
      turns,
      tasks,
      splits,
      estimator: cost.estimator,
      currency: cost.currency,
    });
  }

  /** The usage in a turn's event file, worked out once for as long as the file stays as it is. */
  private backfill(path: string): { usage: TurnUsage; source: 'events' } | undefined {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return undefined;
    const known = this.backfills.get(path);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return { usage: known.usage, source: 'events' };
    const usage = usageOfEventsFile(path);
    this.backfills.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
    return { usage, source: 'events' };
  }

  log(runId: string): LogLine[] {
    const tailer = new LineTailer(this.logPath(runId), { fromEnd: LOG_TAIL_BYTES });
    return parseJsonLines<LogLine>(tailer.read(LOG_TAIL_BYTES).lines).slice(-MAX_LOG_LINES);
  }

  transcript(runId: string, iteration: number): TranscriptEntry[] {
    const path = this.eventsPath(runId, iteration);
    if (existsSync(path)) return transcriptOf(path);
    const journal = journalTranscriptPath(path);
    if (!existsSync(journal)) throw new NotFoundError(`No events for iteration ${iteration} of run ${runId}`);
    return readJournalTranscript(journal);
  }

  /** The transcript of the turn that proposed splitting `taskId`. */
  splitTranscript(runId: string, taskId: string): TranscriptEntry[] {
    const path = this.splitEventsPath(runId, taskId);
    if (existsSync(path)) return transcriptOf(path);
    const journal = journalTranscriptPath(path);
    if (!existsSync(journal)) throw new NotFoundError(`No split of ${taskId} in run ${runId}`);
    return readJournalTranscript(journal);
  }

  /** The highest iteration with an event file (or a journal transcript), 0 before the first. */
  latestIteration(runId: string): number {
    let latest = 0;
    for (const name of safeReaddir(this.runDir(runId))) {
      const match = EVENTS_FILE.exec(name);
      if (match) latest = Math.max(latest, Number(match[1]));
    }
    return latest;
  }

  /** The run's folder in the history, or else in the journal. */
  runDir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new NotFoundError(`No run ${runId}`);
    for (const root of [this.historyRoot, this.journalRoot]) {
      const dir = resolve(root, runId);
      if (existsSync(dir)) return dir;
    }
    throw new NotFoundError(`No run ${runId}`);
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
   * The Ralph folder's files, without its history and journal (which the UI
   * shows as runs), plus the project's ralph.config.json.
   */
  listFiles(): FileEntry[] {
    const files: FileEntry[] = [];
    const visit = (dir: string) => {
      for (const entry of safeReaddir(dir).sort()) {
        if (files.length >= MAX_FILES) return;
        const path = resolve(dir, entry);
        if (path === this.historyRoot || path === this.journalRoot) continue;
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

  /** A listed file's content. Anything else, and anything under history/ or journal/, is not found. */
  readFile(path: string): FileContent {
    const listed = this.listFiles().find((file) => file.path === path);
    if (!listed) throw new NotFoundError(`No file ${path}`);
    const mediaType = imageType(path);
    if (mediaType) return { ...listed, content: '', truncated: false, mediaType };
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

  /** Where a listed image is, for serving its bytes. Any other file is not found. */
  imageFile(path: string): { absolute: string; mediaType: string; size: number } {
    const listed = this.listFiles().find((file) => file.path === path);
    const mediaType = imageType(path);
    if (!listed || !mediaType) throw new NotFoundError(`No image ${path}`);
    return { absolute: resolve(this.projectRoot, path), mediaType, size: listed.size };
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

/** What a record from before usage was metered says: its totals, under an unknown model. */
function legacyUsage(record: IterationRecord): TurnUsage {
  const usage = record.result?.usage;
  if (!usage) return {};
  return {
    [UNKNOWN_MODEL]: {
      steps: 0,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      reasoning: usage.reasoning ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: usage.cost ?? 0,
      inferenceMs: record.result.durationMs ?? 0,
    },
  };
}

function splitView(record: SplitRecord): SplitView {
  const durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
  return {
    taskId: record.taskId,
    iteration: record.iteration,
    ...(record.trigger === 'assessment' ? { trigger: record.trigger } : {}),
    ...(record.estimateMinutes !== undefined ? { estimateMinutes: record.estimateMinutes } : {}),
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
  // Folded a stretch at a time: only the transcript is held, never the file.
  const tailer = new LineTailer(path);
  for (let read = tailer.read(); ; read = tailer.read()) {
    for (const event of parseJsonLines<OpencodeEvent>(read.lines)) builder.push(event);
    if (!read.more) break;
  }
  return builder.all;
}

/** Where the journal keeps the condensed transcript of an event file. */
function journalTranscriptPath(eventsPath: string): string {
  return eventsPath.replace(/\.events\.jsonl$/, '.transcript.jsonl');
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
