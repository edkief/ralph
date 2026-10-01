import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { sleep } from '../opencode/server.js';

/**
 * How the loop and a person talk when the loop cannot go on alone. The loop
 * writes a request to `pending.json`; the web UI or `ralph respond` writes the
 * answer to `answer.json`; the loop reads it and removes both. Files, so the
 * UI may run in another process or container that shares only the Ralph folder.
 */

export const REQUEST_KINDS = ['split', 'decide', 'blocked', 'stalled', 'budget'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const ACTIONS = ['approve', 'retry', 'repropose', 'answer', 'resume', 'continue', 'stop', 'dismiss'] as const;
export type Action = (typeof ACTIONS)[number];

const PendingSchema = z.object({
  id: z.string().min(1),
  runId: z.string(),
  kind: z.enum(REQUEST_KINDS),
  taskId: z.string().nullable(),
  /** What stopped the run, as the terminal shows it. */
  message: z.string(),
  /** The agent's question, for a `decide` request. */
  question: z.string().optional(),
  /** The proposal to review, for a `split` request. Paths are relative to the project root. */
  split: z
    .object({
      dir: z.string(),
      reason: z.string(),
      tasks: z.array(z.object({ id: z.string(), title: z.string(), specPath: z.string() })),
    })
    .optional(),
  /** Whether the loop that asked is waiting for the answer, rather than having exited. */
  waiting: z.boolean(),
  createdAt: z.string(),
});
export type PendingRequest = z.infer<typeof PendingSchema>;

export interface PendingState {
  pending: PendingRequest;
  /** The loop that asked is alive and waiting for the answer. */
  waiting: boolean;
  /** An answer was left and the loop has not picked it up yet. */
  answered: boolean;
  actions: Action[];
}

export const AnswerInputSchema = z.object({
  id: z.string().min(1),
  action: z.enum(ACTIONS),
  /** The answer to a question, or a note for the agent. */
  text: z.string().max(20_000).optional(),
  /** Iterations to add to the budget, for `continue`. */
  iterations: z.number().int().positive().max(10_000).optional(),
});
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

const AnswerSchema = AnswerInputSchema.extend({
  by: z.enum(['ui', 'cli']),
  answeredAt: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export class RespondError extends Error {
  constructor(
    message: string,
    /** `conflict`: nothing to answer, or already answered. `invalid`: the answer does not fit the request. */
    readonly code: 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

export const STOP_MODES = ['after-iteration', 'now'] as const;
export type StopMode = (typeof STOP_MODES)[number];

export const pendingPath = (ralphRoot: string) => resolve(ralphRoot, 'pending.json');
export const answerPath = (ralphRoot: string) => resolve(ralphRoot, 'answer.json');
export const stopPath = (ralphRoot: string) => resolve(ralphRoot, 'stop.json');

/**
 * What a person may do about a request. A loop that is waiting can be told
 * how to go on; once it has exited, only what can be done without it is left.
 */
export function actionsFor(kind: RequestKind, waiting: boolean): Action[] {
  if (waiting) {
    switch (kind) {
      case 'split':
        return ['approve', 'retry', 'repropose', 'stop'];
      case 'decide':
        return ['answer', 'stop'];
      case 'budget':
        return ['continue', 'stop'];
      default:
        return ['resume', 'stop'];
    }
  }
  if (kind === 'split') return ['approve', 'dismiss'];
  if (kind === 'decide') return ['answer', 'dismiss'];
  return ['dismiss'];
}

/** Problems with an answer to `pending`, given whether its loop is waiting; none when it fits. */
export function checkAnswer(pending: PendingRequest, input: AnswerInput, waiting: boolean): string | undefined {
  if (input.id !== pending.id) return 'That request is no longer pending';
  const allowed = actionsFor(pending.kind, waiting);
  if (!allowed.includes(input.action)) {
    return `"${input.action}" is not possible here; choose one of: ${allowed.join(', ')}`;
  }
  if (input.action === 'answer' && !input.text?.trim()) return 'An answer needs text';
  return undefined;
}

export function writePending(ralphRoot: string, pending: PendingRequest): void {
  writeAtomic(pendingPath(ralphRoot), pending);
}

export function readPending(ralphRoot: string): PendingRequest | undefined {
  return readAs(pendingPath(ralphRoot), PendingSchema);
}

export function readAnswer(ralphRoot: string): Answer | undefined {
  return readAs(answerPath(ralphRoot), AnswerSchema);
}

/** Remove the request and any answer to it. */
export function clearPending(ralphRoot: string): void {
  rmSync(pendingPath(ralphRoot), { force: true });
  rmSync(answerPath(ralphRoot), { force: true });
}

/** Leave an answer for the waiting loop. Only the first answer to a request stands. */
export function writeAnswer(ralphRoot: string, answer: Answer): void {
  const path = answerPath(ralphRoot);
  const existing = readAnswer(ralphRoot);
  if (existing?.id === answer.id) throw new RespondError('That request was already answered', 'conflict');
  // An answer to an older request, never collected.
  if (existsSync(path)) rmSync(path, { force: true });
  try {
    writeFileSync(path, `${JSON.stringify(answer, null, 2)}\n`, { flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RespondError('That request was already answered', 'conflict');
    }
    throw cause;
  }
}

/**
 * Wait for the answer to request `id`. Resolves with nothing when `signal`
 * aborts first. `settled` lets the caller notice the request was dealt with
 * some other way (e.g. `ralph split --apply`) and supply the answer itself.
 */
export async function waitForAnswer(args: {
  ralphRoot: string;
  id: string;
  signal: AbortSignal;
  pollMs?: number;
  settled?: () => Answer | undefined;
}): Promise<Answer | undefined> {
  const pollMs = args.pollMs ?? 500;
  for (;;) {
    if (args.signal.aborted) return undefined;
    const answer = readAnswer(args.ralphRoot);
    if (answer?.id === args.id) return answer;
    const settled = args.settled?.();
    if (settled) return settled;
    await sleep(pollMs, args.signal);
  }
}

/** Ask the running loop to stop: after its current iteration, or now. */
export function requestStop(ralphRoot: string, mode: StopMode, by: 'ui' | 'cli'): void {
  writeAtomic(stopPath(ralphRoot), { mode, by, requestedAt: new Date().toISOString() });
}

export function readStopRequest(ralphRoot: string): { mode: StopMode } | undefined {
  return readAs(stopPath(ralphRoot), z.object({ mode: z.enum(STOP_MODES) }));
}

export function clearStopRequest(ralphRoot: string): void {
  rmSync(stopPath(ralphRoot), { force: true });
}

/** Replace `path` in one step, so a reader never sees half of it. */
function writeAtomic(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function readAs<T>(path: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
