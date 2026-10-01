/**
 * What the web UI's API returns. Type-only and free of imports, so the React
 * app can import it without Node's typings.
 */

export interface TaskView {
  id: string;
  title: string;
  category?: string;
  specFilePath?: string;
  passes: boolean;
  /** The task this one was split from, when Ralph split one that kept running out of time. */
  splitFrom?: string;
}

export interface TasksView {
  total: number;
  passed: number;
  /** The task the loop would pick next. */
  next: string | null;
  items: TaskView[];
  /** Why tasks.json could not be read, when it could not. */
  error?: string;
}

/** A run as recorded in its history folder. */
export interface RunView {
  runId: string;
  /** `running`, `waiting` for a person, a final loop status, or `crashed`; `unknown` for a run older than state.json. */
  status: string;
  /** Running or waiting, and its process still there, so worth following. */
  live: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  maxIterations: number | null;
  iteration: number;
  taskId: string | null;
  iterationStartedAt: string | null;
  lastStatus: string | null;
  tasksPassed: number | null;
  tasksTotal: number | null;
  /**
   * The split turn in progress, or the one the run ended on. Null once an
   * iteration has started after it.
   */
  split: { taskId: string; startedAt: string } | null;
  message?: string;
}

/** Something only a person can settle: the loop asked and waits, or stopped over it. */
export interface PendingView {
  id: string;
  runId: string;
  kind: 'split' | 'decide' | 'blocked' | 'stalled' | 'budget';
  taskId: string | null;
  /** What stopped the run. */
  message: string;
  /** The agent's question, for `decide`. */
  question?: string;
  /** The proposal to review, for `split`. Paths are relative to the project root. */
  split?: { dir: string; reason: string; tasks: Array<{ id: string; title: string; specPath: string }> };
  /** The loop is waiting for the answer; otherwise it has exited and is rerun by hand. */
  waiting: boolean;
  /** Answered, and the loop has not picked the answer up yet. */
  answered: boolean;
  /** What can be done about it right now. */
  actions: Array<'approve' | 'retry' | 'repropose' | 'answer' | 'resume' | 'continue' | 'stop' | 'dismiss'>;
  createdAt: string;
}

/** Whether this server takes actions (answers, stop requests), and what the browser needs for them. */
export interface ActionsView {
  enabled: boolean;
  /** Why not, when not. */
  reason?: string;
  /** Requests must carry the configured token. */
  token: boolean;
}

export interface StatusView {
  project: string;
  projectRoot: string;
  ralphDir: string;
  tasks: TasksView;
  /** The latest run, if any. */
  run: RunView | null;
  /** What a person is asked to settle, if anything. */
  pending: PendingView | null;
  /** Absent from a server that takes no actions at all. */
  actions?: ActionsView;
}

export interface FileEntry {
  /** Relative to the project root, with forward slashes. */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface FileContent extends FileEntry {
  content: string;
  /** Only the first part of a large file is returned. */
  truncated: boolean;
  /** Set for an image: `content` is empty, and its bytes are at /api/file/raw. */
  mediaType?: string;
}

export interface IterationView {
  iteration: number;
  taskId: string | null;
  /** The iteration's outcome, or `running` while it has no record yet. */
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  toolCalls: number | null;
  tokens: number | null;
  committed: boolean;
  tasksPassedDelta: number;
  compactions: number;
  handoff?: 'agent' | 'fallback';
  error?: string;
}

/** The agent's turn proposing a split of a task that kept running out of time or context. */
export interface SplitView {
  taskId: string;
  /** The iteration after which the task stalled. */
  iteration: number;
  /** `proposed`, `applied`, `declined` or `failed`; `running` or `ended` while it has no record. */
  status: string;
  /** The tasks proposed in its place. */
  children?: string[];
  /** Why the agent split it this way, advised against it, or failed. */
  reason?: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

export interface RunDetail {
  run: RunView;
  iterations: IterationView[];
  /** Split turns, in the order they ran. */
  splits: SplitView[];
}

export interface LogLine {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

interface EntryBase {
  id: string;
  /** Epoch milliseconds, when the event carried a time. */
  time?: number;
  /** Written by a subagent's session rather than the iteration's own. */
  subagent?: boolean;
}

export type TranscriptEntry =
  | (EntryBase & { kind: 'prompt'; text: string })
  | (EntryBase & { kind: 'text'; text: string; done: boolean })
  | (EntryBase & { kind: 'reasoning'; text: string })
  | (EntryBase & {
      kind: 'tool';
      name: string;
      input?: Record<string, unknown>;
      status: 'running' | 'success' | 'error';
      output?: string;
      exit?: number;
    })
  | (EntryBase & {
      kind: 'step';
      tokens: { input: number; output: number; reasoning: number; cacheRead: number };
      cost: number;
      finish?: string;
    })
  | (EntryBase & { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string });

/** The transcript of the session the live stream follows: an iteration, or a split turn. */
export interface LiveTranscript {
  runId: string;
  /** The iteration followed, or the one a split turn came after. */
  iteration: number;
  /** The task being split, when the session is a split turn. */
  split?: string;
  /** Replace what is shown: a new session began, or this is the first message. */
  reset: boolean;
  /** Entries added or changed since the last message. */
  entries: TranscriptEntry[];
}

/** Server-sent event names on `/api/live` and their payloads. */
export interface LiveEvents {
  status: StatusView;
  log: { runId: string; reset: boolean; lines: LogLine[] };
  transcript: LiveTranscript;
}
