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
  /** `running`, a final loop status, or `crashed`; `unknown` for a run older than state.json. */
  status: string;
  /** Running and still being updated, so worth following. */
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
  message?: string;
}

export interface StatusView {
  project: string;
  projectRoot: string;
  ralphDir: string;
  tasks: TasksView;
  /** The latest run, if any. */
  run: RunView | null;
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

export interface RunDetail {
  run: RunView;
  iterations: IterationView[];
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

/** The transcript of the iteration the live stream follows. */
export interface LiveTranscript {
  runId: string;
  iteration: number;
  /** Replace what is shown: a new iteration began, or this is the first message. */
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
