import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readAs, writeAtomic } from '../human/request.js';
import { newRunId } from '../report/jsonl.js';
import { DONE_COMMAND, type InterviewIO, type InterviewOutcome } from './interview.js';
import type { OpencodeEvent } from '../opencode/events.js';

/**
 * A planning interview as it goes, under `history/plans/<id>/`, apart from
 * the runs: where it stands (`state.json`), what was said
 * (`conversation.jsonl`) and each turn's opencode events
 * (`turn-NNN.events.jsonl`). Whoever is asked writes `reply.json`, and
 * `stop.json` ends it. Files, as for runs, so the web UI may be another
 * process or container that shares only the Ralph folder.
 */

export const PLAN_STATUSES = ['starting', 'working', 'asking', 'planned', 'invalid', 'aborted', 'failed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
const ENDED: readonly PlanStatus[] = ['planned', 'invalid', 'aborted', 'failed'];

export const PLAN_MODES = ['new', 'replan'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** Replies and descriptions, like answers to the loop, are a few paragraphs at most. */
export const MAX_PLAN_TEXT = 20_000;

const PlanStateSchema = z.object({
  id: z.string(),
  mode: z.enum(PLAN_MODES),
  /** Who holds the interview: a daemon for the web UI, or `ralph init` in a terminal. */
  by: z.enum(['daemon', 'cli']),
  status: z.enum(PLAN_STATUSES),
  /** What the owner is asked, while `asking`. */
  prompt: z.string().nullable(),
  /** Numbers each question, so a reply answers the one it was written for. */
  seq: z.number().int().nonnegative(),
  /** The agent's latest tool activity, while `working`. */
  activity: z.string().nullable(),
  turn: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  pid: z.number().int(),
  hostname: z.string(),
  startedAt: z.string(),
  /** Rewritten every few seconds while it goes on, so a reader on another host knows it does. */
  updatedAt: z.string(),
  outcome: z
    .object({
      tasks: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
      problems: z.array(z.string()).optional(),
      reason: z.string().optional(),
      outsideChanges: z.array(z.string()).nullable(),
    })
    .optional(),
});
export type PlanState = z.infer<typeof PlanStateSchema>;

export const PLAN_ROLES = ['owner', 'agent', 'ralph'] as const;
export type PlanRole = (typeof PLAN_ROLES)[number];
export interface PlanLine {
  role: PlanRole;
  text: string;
  at: string;
}

const PlanReplySchema = z.object({
  seq: z.number().int().positive(),
  text: z.string().max(MAX_PLAN_TEXT).optional(),
  /** Write the plan now: the terminal's `/done`. */
  done: z.boolean().optional(),
  by: z.enum(['ui', 'cli']),
  at: z.string(),
});
export type PlanReply = z.infer<typeof PlanReplySchema>;

const PLAN_ID = /^[\w.-]+$/;
const HEARTBEAT_MS = 5_000;
/** A plan on another host whose heartbeat is older than this has died with its process. */
const STALE_MS = 60_000;
/** Tool activity is shown as it changes, but not written more often than this. */
const ACTIVITY_MS = 500;

export const plansRoot = (ralphRoot: string) => resolve(ralphRoot, 'history', 'plans');
export function planDir(ralphRoot: string, id: string): string {
  if (!PLAN_ID.test(id)) throw new PlanRequestError(`No plan session ${id}`, 'invalid');
  return resolve(plansRoot(ralphRoot), id);
}
const statePath = (dir: string) => resolve(dir, 'state.json');
export const conversationPath = (ralphRoot: string, id: string) => resolve(planDir(ralphRoot, id), 'conversation.jsonl');
const replyPath = (ralphRoot: string, id: string) => resolve(planDir(ralphRoot, id), 'reply.json');
const stopPath = (ralphRoot: string, id: string) => resolve(planDir(ralphRoot, id), 'stop.json');

export class PlanRequestError extends Error {
  constructor(
    message: string,
    /** `conflict`: nothing waits for it, or it was dealt with already. `invalid`: it does not fit. */
    readonly code: 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

/** A new session id, from the time as runs have theirs, unique among the plans already here. */
export function newPlanId(ralphRoot: string, now = new Date()): string {
  const base = newRunId(now);
  let id = base;
  for (let n = 2; existsSync(resolve(plansRoot(ralphRoot), id)); n += 1) id = `${base}-${n}`;
  return id;
}

/** Plan sessions, newest first. */
export function listPlanIds(ralphRoot: string): string[] {
  try {
    return readdirSync(plansRoot(ralphRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PLAN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function readPlanState(ralphRoot: string, id: string): PlanState | undefined {
  return readAs(statePath(planDir(ralphRoot, id)), PlanStateSchema);
}

export function readConversation(ralphRoot: string, id: string): PlanLine[] {
  try {
    return readFileSync(conversationPath(ralphRoot, id), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as PlanLine];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function planEnded(status: PlanStatus): boolean {
  return ENDED.includes(status);
}

/** Whether the process holding the interview is still at it. */
export function planLive(state: PlanState, now: number = Date.now()): boolean {
  if (planEnded(state.status)) return false;
  if (state.hostname === hostname()) {
    try {
      process.kill(state.pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  return now - Date.parse(state.updatedAt) < STALE_MS;
}

/** The session's state, or why it takes no reply or stop. */
function liveState(ralphRoot: string, id: string): PlanState {
  const state = readPlanState(ralphRoot, id);
  if (!state) throw new PlanRequestError(`No plan session ${id}`, 'conflict');
  if (!planLive(state)) throw new PlanRequestError('That planning session has ended', 'conflict');
  return state;
}

/**
 * Answer the question numbered `seq`. Only the first reply to it stands, and
 * only while it is still the question asked.
 */
export function writePlanReply(
  ralphRoot: string,
  id: string,
  reply: { seq: number; text?: string; done?: boolean },
  by: 'ui' | 'cli',
): void {
  const state = liveState(ralphRoot, id);
  if (state.status !== 'asking' || state.seq !== reply.seq) {
    throw new PlanRequestError('That question is no longer asked', 'conflict');
  }
  if (!reply.done && !reply.text?.trim()) throw new PlanRequestError('A reply needs text', 'invalid');
  const path = replyPath(ralphRoot, id);
  const existing = readAs(path, PlanReplySchema);
  if (existing?.seq === reply.seq) throw new PlanRequestError('That question was already answered', 'conflict');
  // The reply to an earlier question, collected long ago.
  if (existsSync(path)) rmSync(path, { force: true });
  const value: PlanReply = {
    seq: reply.seq,
    ...(reply.done ? { done: true } : { text: reply.text! }),
    by,
    at: new Date().toISOString(),
  };
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PlanRequestError('That question was already answered', 'conflict');
    }
    throw cause;
  }
}

export function readPlanReply(ralphRoot: string, id: string): PlanReply | undefined {
  return readAs(replyPath(ralphRoot, id), PlanReplySchema);
}

/** Ask the interview to end: the turn in progress is interrupted, and it ends as `aborted`. */
export function requestPlanStop(ralphRoot: string, id: string, by: 'ui' | 'cli'): void {
  liveState(ralphRoot, id);
  writeAtomic(stopPath(ralphRoot, id), { by, requestedAt: new Date().toISOString() });
}

export function planStopRequested(ralphRoot: string, id: string): boolean {
  return existsSync(stopPath(ralphRoot, id));
}

/** The live session, if any: there is at most one, as a project has one owner. */
export function livePlan(ralphRoot: string): PlanState | undefined {
  const id = listPlanIds(ralphRoot)[0];
  const state = id ? readPlanState(ralphRoot, id) : undefined;
  return state && planLive(state) ? state : undefined;
}

/** Writes a session's files as the interview goes. */
export class PlanRecorder {
  readonly id: string;
  readonly dir: string;
  private readonly state: PlanState;
  private events: string | null = null;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastActivity = 0;
  private pendingActivity: NodeJS.Timeout | undefined;

  constructor(
    readonly ralphRoot: string,
    init: { mode: PlanMode; by: 'daemon' | 'cli'; id?: string },
  ) {
    this.id = init.id ?? newPlanId(ralphRoot);
    this.dir = planDir(ralphRoot, this.id);
    mkdirSync(this.dir, { recursive: true });
    const now = new Date().toISOString();
    this.state = {
      id: this.id,
      mode: init.mode,
      by: init.by,
      status: 'starting',
      prompt: null,
      seq: 0,
      activity: null,
      turn: 0,
      maxTurns: null,
      model: null,
      pid: process.pid,
      hostname: hostname(),
      startedAt: now,
      updatedAt: now,
    };
    this.save();
    this.heartbeat = setInterval(() => this.save(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get current(): Readonly<PlanState> {
    return this.state;
  }

  update(patch: Partial<PlanState>): void {
    Object.assign(this.state, patch);
    this.save();
  }

  line(role: PlanRole, text: string): void {
    const entry: PlanLine = { role, text, at: new Date().toISOString() };
    appendFileSync(resolve(this.dir, 'conversation.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  /** A turn begins: its events go to a file of their own. */
  turn(n: number): void {
    this.events = resolve(this.dir, `turn-${String(n).padStart(3, '0')}.events.jsonl`);
    writeFileSync(this.events, '');
    this.update({ turn: n, status: 'working', prompt: null, activity: null });
  }

  recordEvent(event: OpencodeEvent): void {
    if (this.events) appendFileSync(this.events, `${JSON.stringify(event)}\n`);
  }

  /** Tool activity, written at most every half second; the latest always lands. */
  activity(text: string): void {
    this.state.activity = text;
    clearTimeout(this.pendingActivity);
    const wait = this.lastActivity + ACTIVITY_MS - Date.now();
    if (wait <= 0) {
      this.lastActivity = Date.now();
      this.save();
      return;
    }
    this.pendingActivity = setTimeout(() => {
      this.lastActivity = Date.now();
      this.save();
    }, wait);
    this.pendingActivity.unref();
  }

  /** A new question for the owner; returns its number. */
  asking(prompt: string): number {
    clearTimeout(this.pendingActivity);
    this.update({ status: 'asking', prompt, seq: this.state.seq + 1, activity: null });
    return this.state.seq;
  }

  /** The owner replied: back to the agent. */
  replied(): void {
    this.update({ status: 'working', prompt: null });
  }

  finish(outcome: InterviewOutcome): void {
    this.end({
      status: outcome.status,
      outcome: {
        outsideChanges: outcome.outsideChanges,
        ...(outcome.status === 'planned' ? { tasks: outcome.tasks.map((task) => ({ id: task.id, title: task.title })) } : {}),
        ...(outcome.status === 'invalid' ? { problems: outcome.problems } : {}),
        ...(outcome.status === 'failed' ? { reason: outcome.reason } : {}),
      },
    });
  }

  /** End without an interview outcome: it never got going, or broke. */
  fail(reason: string): void {
    this.end({ status: 'failed', outcome: { reason, outsideChanges: null } });
  }

  close(): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.pendingActivity);
    this.heartbeat = this.pendingActivity = undefined;
  }

  private end(patch: Pick<PlanState, 'status' | 'outcome'>): void {
    this.close();
    this.update({ ...patch, prompt: null, activity: null });
  }

  private save(): void {
    this.state.updatedAt = new Date().toISOString();
    writeAtomic(statePath(this.dir), this.state);
  }
}

/**
 * An interview's IO that also records it: what the agent and Ralph say, each
 * question and the reply it got, and the tool activity. The terminal's IO in
 * `ralph init`, the reply file's in a daemon.
 */
export class RecordingIO implements InterviewIO {
  constructor(
    protected readonly inner: InterviewIO,
    readonly recorder: PlanRecorder,
  ) {}

  say(text: string): void {
    this.recorder.line('agent', text);
    this.inner.say(text);
  }

  status(text: string): void {
    this.recorder.activity(text);
    this.inner.status(text);
  }

  note(text: string): void {
    this.recorder.line('ralph', text);
    this.inner.note(text);
  }

  async ask(prompt: string): Promise<string | null> {
    this.recorder.asking(prompt);
    const answer = await this.inner.ask(prompt);
    if (answer !== null && answer.trim() !== '') {
      this.recorder.line('owner', answer.trim() === DONE_COMMAND ? DONE_COMMAND : answer);
      this.recorder.replied();
    }
    return answer;
  }

  turn(n: number): void {
    this.recorder.turn(n);
    this.inner.turn?.(n);
  }
}
