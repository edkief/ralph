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
   * The split turn in progress, or the one the run ended on; with `phase:
   * 'assess'`, the assessment of a task before its first attempt. Null once
   * an iteration has started after it.
   */
  split: { taskId: string; startedAt: string; phase?: 'assess' | 'split' } | null;
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

/**
 * The agent's turn proposing a split of a task that kept running out of time
 * or context, or assessing a task before its first attempt.
 */
export interface SplitView {
  taskId: string;
  /** The iteration after which the task stalled, or the one the assessment came before. */
  iteration: number;
  /** Set for the assessment of a task before its first attempt, and the split that came of it. */
  trigger?: 'assessment';
  /** The working time the agent estimated, in an assessment. */
  estimateMinutes?: number;
  /** `proposed`, `applied`, `declined`, `retry`, `failed` or `fits`; `running` or `ended` while it has no record. */
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

/** A file that differs from the last commit. */
export interface GitFileChange {
  /** Relative to the repository's root. */
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';
  /** Some of the change is in the index. */
  staged: boolean;
  /** Some of the change is only in the working tree. */
  unstaged: boolean;
  /** The path it was renamed or copied from. */
  from?: string;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601, as the author's clock had it. */
  date: string;
  subject: string;
}

/** The project's repository, or why there is nothing to show of it. */
export type GitView =
  | { available: false; reason: string }
  | {
      available: true;
      /** Null when HEAD is detached. */
      branch: string | null;
      /** The commit checked out; null before the first commit. */
      head: string | null;
      upstream: string | null;
      /** Commits the branch has that its upstream lacks, and the reverse, as of the last fetch. */
      ahead: number;
      behind: number;
      changes: GitFileChange[];
      /** Only the first part of a long list of changes is returned. */
      changesTruncated: boolean;
      /** The latest commits, newest first. */
      commits: GitCommitSummary[];
    };

export interface GitFileStat {
  path: string;
  from?: string;
  added: number;
  removed: number;
  /** Git counts no lines for it. */
  binary: boolean;
}

export interface GitCommitDetail extends GitCommitSummary {
  parents: string[];
  email: string;
  /** The message after its subject. */
  body: string;
  /** Only the first part of a long list of files is returned; the totals count them all. */
  files: GitFileStat[];
  filesChanged: number;
  added: number;
  removed: number;
}
