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

/** A task that was split, and so is gone from tasks.json, as its split record keeps it. */
export interface SplitTaskView {
  id: string;
  /** Null for an older record with no archived spec to read it from. */
  title: string | null;
  /** Its archived spec. */
  specFilePath?: string;
  /** The tasks it was split into, in order. */
  children: string[];
}

export interface TasksView {
  total: number;
  passed: number;
  /** The task the loop would pick next. */
  next: string | null;
  items: TaskView[];
  /** Tasks that were split, which `items` and the counts leave out. */
  splits: SplitTaskView[];
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
  /** Working time an iteration gets before the agent is asked to wrap up; null for older runs. */
  iterationMs: number | null;
  lastStatus: string | null;
  tasksPassed: number | null;
  tasksTotal: number | null;
  /**
   * The split turn in progress, or the one the run ended on; with `phase:
   * 'assess'`, the assessment of a task before its first attempt. Null once
   * an iteration has started after it.
   */
  split: { taskId: string; startedAt: string; phase?: 'assess' | 'split' } | null;
  /** The escalation turn in progress, or the last one, until the next iteration starts. */
  escalation: { n: number; kind: string; taskId: string | null; startedAt: string } | null;
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
  /** What the escalation agent found when it passed the request on, or why it could not settle it. */
  analysis?: string;
  /** The loop is waiting for the answer; otherwise it has exited and is rerun by hand. */
  waiting: boolean;
  /** Answered, and the loop has not picked the answer up yet. */
  answered: boolean;
  /** What can be done about it right now. */
  actions: Array<'approve' | 'retry' | 'repropose' | 'answer' | 'resume' | 'continue' | 'stop' | 'dismiss'>;
  createdAt: string;
}

/** A value in a form's answer, by field type: text, a number, a yes/no, or the options picked. */
export type FormValue = string | number | boolean | string[];

/** A condition on another field's answer that shows a field. */
export interface FormWhen {
  key: string;
  op: 'eq' | 'neq';
  value: string | number | boolean;
}

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

interface FormFieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  /** Shown only when every condition holds. */
  when?: FormWhen[];
}

/**
 * A field of an opencode form, as its `question` tool or an MCP server's
 * request for input opens one. `custom` lets an answer go beyond `options`.
 */
export type FormField =
  | (FormFieldBase & {
      type: 'string';
      format?: 'email' | 'uri' | 'date' | 'date-time';
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
      default?: string;
      options?: FormOption[];
      custom?: boolean;
    })
  | (FormFieldBase & { type: 'number' | 'integer'; minimum?: number; maximum?: number; default?: number })
  | (FormFieldBase & { type: 'boolean'; default?: boolean })
  | (FormFieldBase & {
      type: 'multiselect';
      options: FormOption[];
      minItems?: number;
      maxItems?: number;
      custom?: boolean;
      default?: string[];
    })
  | (FormFieldBase & { type: 'external'; url: string });

/**
 * Something the agent waits on a person for, in the middle of its turn: a
 * form to fill in, or, with `permissions.fallback: ask`, a permission to grant.
 */
export interface AskView {
  id: string;
  kind: 'form' | 'permission';
  /** A run's turn, or a planning interview held from the web UI. */
  origin: 'run' | 'plan';
  runId?: string;
  planId?: string;
  taskId: string | null;
  form?: {
    title: string;
    /** `question` for opencode's question tool, `mcp` for an MCP server's request. */
    source?: string;
    fields: FormField[];
  };
  permission?: { action: string; resources: string[]; message?: string };
  /** Why the last answer was not taken, to be put right. */
  error?: string;
  /** Answered, and the loop has not delivered it yet. */
  answered: boolean;
  createdAt: string;
  /** When it is given up on, if ever. */
  expiresAt?: string;
}

/**
 * What a push notification can be sent for: a request reaching a person, a
 * run ending, an iteration ending, a task passing. Each browser picks its own.
 */
export type PushEvent = 'request' | 'run-end' | 'iteration' | 'task';

/** Whether this server sends push notifications, and what a browser needs to subscribe. */
export interface PushView {
  enabled: boolean;
  /** The VAPID public key, base64url, for `pushManager.subscribe`. */
  publicKey: string | null;
  events: PushEvent[];
  /** What a new subscription gets unless it asks otherwise. */
  defaults: PushEvent[];
}

/** What the service worker shows. `path` is the view, as a hash route; `base` replaces the worker's scope when set. */
export interface PushPayload {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  path: string;
  base?: string;
}

/** Whether this server takes actions (answers, stop requests), and what the browser needs for them. */
export interface ActionsView {
  enabled: boolean;
  /** Why not, when not. */
  reason?: string;
  /** Requests must carry the configured token. */
  token: boolean;
  /** Park works with nothing running: Ralph's records are committed and the branch pushed. */
  park: boolean;
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
  /** The project's daemon, if one has ever run here; `live` says whether it still does. */
  daemon: DaemonView | null;
  /** The latest planning session, while it goes on and for a day after; null otherwise. */
  plan: PlanSummary | null;
  /** `template` while the PRD and task list are still the scaffold's (or missing), `written` once there is a plan. */
  planState: 'template' | 'written';
  /** Absent from a server that takes no actions at all. */
  actions?: ActionsView;
}

/** A line of a planning interview: the owner, the agent, or a notice from Ralph. */
export interface PlanLineView {
  role: 'owner' | 'agent' | 'ralph';
  text: string;
  at: string;
}

/** A planning interview: a daemon's, held from the web UI, or one `ralph init` held in a terminal. */
export interface PlanSummary {
  id: string;
  /** A plan for a project that had none, or a revision. */
  mode: 'new' | 'replan';
  /** Who holds it: a daemon, or `ralph init` in a terminal. */
  by: 'daemon' | 'cli';
  /**
   * `starting`, the agent `working`, `asking` the owner, or how it ended:
   * `planned`, `invalid`, `aborted` (stopped, or its process gone) or `failed`.
   */
  status: 'starting' | 'working' | 'asking' | 'planned' | 'invalid' | 'aborted' | 'failed';
  /** Its process is at it still. */
  live: boolean;
  /** Numbers the question asked; a reply names the one it answers. */
  seq: number;
  /** The question, while `asking`. */
  prompt: string | null;
  /** The agent's latest tool activity, while `working`. */
  activity: string | null;
  turn: number;
  maxTurns: number | null;
  model: string | null;
  startedAt: string;
  outcome?: {
    /** The tasks of the plan written. */
    tasks?: Array<{ id: string; title: string }>;
    /** What is still wrong with the plan, when it stayed invalid. */
    problems?: string[];
    /** Why it failed. */
    reason?: string;
    /** Files the agent changed outside the Ralph folder; null when that could not be checked. */
    outsideChanges: string[] | null;
  };
}

export interface PlanView extends PlanSummary {
  conversation: PlanLineView[];
}

/** A `ralph daemon` that holds the loop and runs batches of iterations on request. */
export interface DaemonView {
  live: boolean;
  /** `idle` between batches, `running` one, `planning` an interview, `stopping`, or `stopped` once gone. */
  status: string;
  pid: number;
  hostname: string;
  startedAt: string;
  /** Iterations a run request without a number gets. */
  defaultIterations: number;
  /** The batch in progress. */
  batch: { iterations: number; startedAt: string } | null;
  /** How the last batch ended. */
  lastBatch: { status: string; message: string; endedAt: string } | null;
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
  /** How a task left passing by an attempt that was cut short was settled. */
  confirm?: { verdict: 'confirmed' | 'reopened'; doubt: string; reason?: string };
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

/** A turn of the escalation agent, which got a request before a person did. */
export interface EscalationView {
  /** The run's escalation turns are numbered from 1. */
  n: number;
  /** The iteration the request came after. */
  iteration: number;
  /** The kind of request: `blocked`, `decide`, `stalled`, `split` or `budget`. */
  kind: string;
  taskId: string | null;
  /** `resolved`, `escalated` or `failed`; `running` or `ended` while it has no record. */
  status: string;
  /** The answer it gave, when it settled the request. */
  action?: string;
  /** Its note to the coding agent, its analysis for a person, or why the turn failed. */
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
  /** Escalation turns, in the order they ran. */
  escalations: EscalationView[];
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
  /** The escalation turn's number, when the session is one. */
  escalation?: number;
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
  /** The latest planning session's conversation: whole with `reset`, else the lines added. */
  plan: { id: string; reset: boolean; lines: PlanLineView[] };
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

/** Model work over some stretch: calls, tokens by kind, time generating, and what it cost. */
export interface MetricsUsage {
  /** Model calls that ended. */
  steps: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** Every token above together. */
  tokens: number;
  /** Time the models spent generating; for approximate turns, their wall-clock time. */
  inferenceMs: number;
  /** What opencode reported, from the provider's prices; 0 for most self-hosted models. */
  reportedCost: number;
  /** The configured estimate, in `MetricsView.cost.currency`; null when none is configured. */
  estimatedCost: number | null;
  /** Energy drawn, in kWh, from the configured power draw; null when none is configured. */
  energyKwh: number | null;
}

/** One turn of a run: an iteration, a planning turn (an assessment or a split proposal), or an escalation. */
export interface MetricsTurn extends MetricsUsage {
  runId: string;
  kind: 'iteration' | 'assessment' | 'split' | 'escalation';
  iteration: number;
  /** The escalation turn's number in its run, for an escalation. */
  escalation?: number;
  taskId: string | null;
  startedAt: string | null;
  /** Wall-clock time, tool runs included. */
  wallMs: number | null;
  /** The models the turn ran. */
  models: string[];
  /**
   * `recorded` with the turn; `events` worked out from its event file, for a turn
   * recorded before usage was; `legacy` only its record's totals, under an unknown
   * model and with wall-clock time; `none` when nothing says.
   */
  source: 'recorded' | 'events' | 'legacy' | 'none';
}

export interface MetricsModel extends MetricsUsage {
  /** `provider/model`, or `unknown`. */
  model: string;
  turns: number;
}

export interface MetricsRun extends MetricsUsage {
  runId: string;
  status: string;
  startedAt: string | null;
  iterations: number;
  planningTurns: number;
  wallMs: number;
}

export interface MetricsTask extends MetricsUsage {
  id: string;
  /** Null for a task no longer in tasks.json, such as one that was split. */
  title: string | null;
  /** Null for a task no longer in tasks.json. */
  passes: boolean | null;
  /** The task it was split from. */
  parent: string | null;
  /** The tasks it was split into, in order. */
  children: string[];
  iterations: number;
  planningTurns: number;
  /** The task's own figures plus those of every task split from it, at any depth. */
  total: MetricsUsage & { iterations: number; planningTurns: number };
}

export interface MetricsView {
  totals: MetricsUsage & { runs: number; iterations: number; planningTurns: number; wallMs: number };
  /** Most tokens first. */
  models: MetricsModel[];
  /** Newest first. */
  runs: MetricsRun[];
  /** In backlog order, a split task before the tasks it was split into. */
  tasks: MetricsTask[];
  /** Oldest first; the browser groups them by day in its own time zone. */
  turns: MetricsTurn[];
  cost: {
    /** The estimator in use; null until one is configured. */
    estimator: string | null;
    currency: string;
    /** How estimates are made, in a line. */
    basis: string | null;
  };
  energy: {
    /** How energy is estimated, in a line; null until a power draw is configured. */
    basis: string | null;
  };
  /** How many turns had their usage from each source. */
  coverage: Record<MetricsTurn['source'], number>;
}
