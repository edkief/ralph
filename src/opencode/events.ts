import { z } from 'zod';

/**
 * opencode SSE frames are `{ type, data, ... }`. We validate only the fields
 * the loop reacts to and keep the rest as-is, so a server upgrade that adds
 * fields (or event types) cannot crash the loop.
 */
export const OpencodeEventSchema = z.looseObject({
  type: z.string(),
  data: z.unknown().optional(),
});

export type OpencodeEvent = z.infer<typeof OpencodeEventSchema>;

const TokensSchema = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  reasoning: z.number().optional(),
  cache: z.looseObject({ read: z.number().optional(), write: z.number().optional() }).optional(),
});

export const TextEndedSchema = z.looseObject({
  sessionID: z.string().optional(),
  text: z.string().default(''),
});

export const ToolCalledSchema = z.looseObject({
  id: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

/** Carries the tool's name; `session.tool.called` only carries its input. */
export const ToolInputStartedSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
});

export const ToolResultSchema = z.looseObject({
  id: z.string().optional(),
  content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
  metadata: z.looseObject({ exit: z.number().optional(), status: z.string().optional() }).optional(),
});

export const UsageSchema = z.looseObject({
  cost: z.number().optional(),
  tokens: TokensSchema.optional(),
});

export const StepEndedSchema = z.looseObject({
  finish: z.string().optional(),
  tokens: TokensSchema.optional(),
  cost: z.number().optional(),
  files: z.array(z.string()).optional(),
});

export const RetryScheduledSchema = z.looseObject({
  attempt: z.number().optional(),
  error: z
    .looseObject({
      type: z.string().optional(),
      message: z.string().optional(),
      status: z.number().optional(),
    })
    .optional(),
});

export const ExecutionEndedSchema = z.looseObject({
  sessionID: z.string().optional(),
  error: z.unknown().optional(),
});

/** A model call that failed, e.g. because the request overflowed the context window. */
export const StepFailedSchema = z.looseObject({
  error: z.unknown().optional(),
});

/**
 * The message of an error on the event stream. v2 sends `{ type, message }`,
 * v1 `{ name, data: { message } }`, and some paths a bare string.
 */
export function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error || undefined;
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { message?: unknown; data?: { message?: unknown }; name?: unknown; type?: unknown };
  for (const candidate of [record.message, record.data?.message, record.name, record.type]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
}

export const PermissionRequestSchema = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  action: z.string(),
  resources: z.array(z.string()).default([]),
  message: z.string().optional(),
});

export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/**
 * A form waiting on an answer: what opencode's `question` tool and an MCP
 * server's request for input open. The asker waits until it is replied to or
 * cancelled.
 */
export const FormCreatedSchema = z.looseObject({
  form: z.looseObject({
    id: z.string(),
    sessionID: z.string(),
    title: z.string().optional(),
    metadata: z.looseObject({ kind: z.string().optional() }).optional(),
    fields: z.array(z.looseObject({ key: z.string(), type: z.string() })).optional(),
  }),
});

/** `form.replied` or `form.cancelled`: a form settled, by whoever answered it. */
export const FORM_SETTLED_EVENTS = new Set(['form.replied', 'form.cancelled']);
export const FormSettledSchema = z.looseObject({ id: z.string(), sessionID: z.string().optional() });

/**
 * Not opencode's: Ralph records this in a turn's event file when the turn
 * starts work in a session, before any of the session's own events. It names
 * the turn's own sessions, which the event stream does not: `session.created`
 * carries no parent, so a retry's fresh session and a subagent's look alike.
 */
export const TURN_STARTED_EVENT = 'ralph.turn.started';

export const TurnStartedSchema = z.looseObject({
  sessionID: z.string(),
  /** The turn carries on a session an earlier turn started. */
  continued: z.boolean().optional(),
});

/** Carries the parent of a subagent session, so its work can be attributed. */
export const SessionCreatedSchema = z.looseObject({
  sessionID: z.string(),
  parentID: z.string().optional(),
});

/**
 * Whether a session-scoped event proves the agent is alive, resetting the
 * inactivity watchdog. Any `session.*` event counts — a fixed allowlist misses
 * quiet phases such as `session.step.started` while a local model is still
 * processing the prompt. Provider retries are the exception: they mean the
 * agent is stuck, and the retry-storm check counts them separately.
 */
export function isActivityEvent(type: string): boolean {
  return type.startsWith('session.') && type !== 'session.retry.scheduled';
}

export const EXECUTION_DONE_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.aborted',
]);

/**
 * Incremental SSE frame parser. Feed it decoded chunks; it yields one parsed
 * event per complete `data:` frame and keeps any partial tail buffered.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): OpencodeEvent[] {
    this.buffer += chunk;
    const events: OpencodeEvent[] = [];

    let boundary = this.nextBoundary();
    while (boundary !== null) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const event = parseFrame(frame);
      if (event) events.push(event);
      boundary = this.nextBoundary();
    }
    return events;
  }

  private nextBoundary(): { index: number; length: number } | null {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    if (lf === -1 && crlf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }
}

function parseFrame(frame: string): OpencodeEvent | null {
  const payload = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (!payload || payload === '[DONE]') return null;

  try {
    const parsed = OpencodeEventSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The session a session-scoped event belongs to; a form event names it on the form. */
export function sessionIdOf(event: OpencodeEvent): string | undefined {
  const data = event.data as { sessionID?: unknown; form?: { sessionID?: unknown } } | undefined;
  if (typeof data?.sessionID === 'string') return data.sessionID;
  return typeof data?.form?.sessionID === 'string' ? data.form.sessionID : undefined;
}

/** A tool's name where the event carries one, else a generic `tool`. */
export function toolName(event: OpencodeEvent): string {
  const data = event.data as { tool?: unknown; name?: unknown } | undefined;
  if (typeof data?.tool === 'string') return data.tool;
  if (typeof data?.name === 'string') return data.name;
  return 'tool';
}

/** Narrow an event's `data` with a schema, returning undefined when it does not fit. */
export function readData<T>(event: OpencodeEvent, schema: z.ZodType<T>): T | undefined {
  const parsed = schema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}
