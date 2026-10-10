import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { sleep } from '../opencode/server.js';
import { readAs, writeAtomic } from './request.js';
import type { FormAnswer } from '../ui/form-check.js';
import type { FormField } from '../ui/types.js';

/**
 * What an agent waits on a person for in the middle of its turn: a form (the
 * `question` tool, an MCP server's request for input) or a permission the
 * policy leaves to a person. The turn's process writes `history/asks/<id>.json`;
 * the web UI writes the answer beside it as `<id>.answer.json`; the process
 * hands the answer to opencode and removes both. Files, like `pending.json`, so
 * the UI may run elsewhere and share only the Ralph folder.
 */

export const PERMISSION_DECISIONS = ['once', 'always', 'reject'] as const;
export type PermissionDecisionReply = (typeof PERMISSION_DECISIONS)[number];

/** Form and permission ids as opencode makes them; also safe as file names. */
const ASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

const FormValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const AskSchema = z.object({
  id: z.string().regex(ASK_ID),
  kind: z.enum(['form', 'permission']),
  origin: z.enum(['run', 'plan']),
  runId: z.string().optional(),
  planId: z.string().optional(),
  taskId: z.string().nullable(),
  /** The opencode session that waits, for replies. */
  sessionID: z.string(),
  form: z
    .object({
      title: z.string(),
      source: z.string().optional(),
      // As opencode sent them; the UI renders the types it knows.
      fields: z.array(z.looseObject({ key: z.string(), type: z.string() })),
    })
    .optional(),
  permission: z
    .object({ action: z.string(), resources: z.array(z.string()), message: z.string().optional() })
    .optional(),
  /** The process that waits, to tell a live ask from one left behind. */
  pid: z.number().int(),
  hostname: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  error: z.string().optional(),
});
export type Ask = Omit<z.infer<typeof AskSchema>, 'form'> & {
  form?: { title: string; source?: string; fields: FormField[] };
};

export const AskAnswerInputSchema = z.union([
  z.object({ id: z.string().regex(ASK_ID), answer: z.record(z.string(), FormValueSchema) }).strict(),
  z.object({ id: z.string().regex(ASK_ID), cancel: z.string().max(2_000) }).strict(),
  z.object({ id: z.string().regex(ASK_ID), decision: z.enum(PERMISSION_DECISIONS) }).strict(),
]);
export type AskAnswerInput = z.infer<typeof AskAnswerInputSchema>;

const AskAnswerSchema = z.object({
  id: z.string(),
  answer: z.record(z.string(), FormValueSchema).optional(),
  cancel: z.string().optional(),
  decision: z.enum(PERMISSION_DECISIONS).optional(),
  by: z.enum(['ui', 'cli']),
  answeredAt: z.string(),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export class AskError extends Error {
  constructor(
    message: string,
    /** `conflict`: nothing to answer, or already answered. `invalid`: the answer does not fit. */
    readonly code: 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

export const asksDir = (ralphRoot: string) => resolve(ralphRoot, 'history', 'asks');
const askPath = (ralphRoot: string, id: string) => resolve(asksDir(ralphRoot), `${checkId(id)}.json`);
const answerPath = (ralphRoot: string, id: string) => resolve(asksDir(ralphRoot), `${checkId(id)}.answer.json`);

function checkId(id: string): string {
  if (!ASK_ID.test(id)) throw new AskError(`Not an ask id: ${id}`, 'invalid');
  return id;
}

/** Leave an ask for a person; a fresh one replaces any answer to an ask of the same id. */
export function writeAsk(ralphRoot: string, ask: Omit<Ask, 'pid' | 'hostname'>): Ask {
  const full: Ask = { ...ask, pid: process.pid, hostname: hostname() };
  rmSync(answerPath(ralphRoot, ask.id), { force: true });
  writeAtomic(askPath(ralphRoot, ask.id), full);
  return full;
}

export function readAsk(ralphRoot: string, id: string): Ask | undefined {
  return readAs(askPath(ralphRoot, id), AskSchema) as Ask | undefined;
}

/** Every ask on file, oldest first, whether or not its process still waits. */
export function listAsks(ralphRoot: string): Ask[] {
  let names: string[];
  try {
    names = readdirSync(asksDir(ralphRoot));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.answer.json'))
    .flatMap((name) => {
      const ask = readAs(resolve(asksDir(ralphRoot), name), AskSchema) as Ask | undefined;
      return ask ? [ask] : [];
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function readAskAnswer(ralphRoot: string, id: string): AskAnswer | undefined {
  return readAs(answerPath(ralphRoot, id), AskAnswerSchema);
}

/** Whether the process that left `ask` is still there, as far as this machine can tell. */
export function askProcessAlive(ask: Ask): boolean | undefined {
  if (ask.hostname !== hostname()) return undefined;
  try {
    process.kill(ask.pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Leave the answer to an ask. Only the first answer stands, until the asker turns it down. */
export function writeAskAnswer(ralphRoot: string, answer: AskAnswer): void {
  const ask = readAsk(ralphRoot, answer.id);
  if (!ask) throw new AskError('That is no longer asked', 'conflict');
  const fits =
    ask.kind === 'permission' ? answer.decision !== undefined : answer.answer !== undefined || answer.cancel !== undefined;
  if (!fits) {
    throw new AskError(ask.kind === 'permission' ? 'A permission takes once, always or reject' : 'A form takes an answer or a cancel', 'invalid');
  }
  mkdirSync(asksDir(ralphRoot), { recursive: true });
  try {
    writeFileSync(answerPath(ralphRoot, answer.id), `${JSON.stringify(answer, null, 2)}\n`, { flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new AskError('That was already answered', 'conflict');
    throw cause;
  }
}

/** The answer was not taken: say why and make way for another. */
export function rejectAskAnswer(ralphRoot: string, id: string, error: string): void {
  const ask = readAsk(ralphRoot, id);
  if (ask) writeAtomic(askPath(ralphRoot, id), { ...ask, error });
  rmSync(answerPath(ralphRoot, id), { force: true });
}

/** Remove an ask and any answer to it. */
export function clearAsk(ralphRoot: string, id: string): void {
  rmSync(askPath(ralphRoot, id), { force: true });
  rmSync(answerPath(ralphRoot, id), { force: true });
}

/** Wait for an answer to ask `id`; nothing comes back once `signal` aborts. */
export async function waitForAskAnswer(args: {
  ralphRoot: string;
  id: string;
  signal: AbortSignal;
  pollMs?: number;
}): Promise<AskAnswer | undefined> {
  const pollMs = args.pollMs ?? 500;
  for (;;) {
    if (args.signal.aborted) return undefined;
    const answer = readAskAnswer(args.ralphRoot, args.id);
    if (answer) return answer;
    await sleep(pollMs, args.signal);
  }
}

export type { FormAnswer };
