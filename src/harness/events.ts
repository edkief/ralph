import { z } from 'zod';
import type { FormField } from '../ui/types.js';

/**
 * Ralph's own event vocabulary: what every harness adapter emits, and what the
 * loop, the transcript, the metrics, the journal and the records read. A
 * harness's wire format stops at its adapter.
 *
 * Every event is `{ type, created?, session?, ...fields }`: `created` is epoch
 * milliseconds, and `session` the session the event belongs to. Fields a
 * harness cannot supply are absent, never invented.
 *
 * Event files record this vocabulary, led by a header naming the harness and
 * `HISTORY_VOCABULARY`. Raise that number when an event changes meaning or a
 * field changes shape; adding an event type or an optional field needs no new
 * version, as readers skip what they do not know.
 */
export const HISTORY_VOCABULARY = 1;

/** The first line of an event file Ralph wrote. */
export const HISTORY_HEADER_TYPE = 'history.header';

export const HistoryHeaderSchema = z.object({
  type: z.literal(HISTORY_HEADER_TYPE),
  /** `AgentHarness.name` of the harness that produced the events. */
  harness: z.string(),
  vocabulary: z.number().int(),
});

export type HistoryHeader = z.infer<typeof HistoryHeaderSchema>;

const Base = z.object({
  created: z.number().optional(),
  session: z.string().optional(),
});

/** What one model call used. Zero where the harness does not report a figure. */
export const StepUsageSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  /** Thinking tokens, where the harness counts them apart from `output`. */
  reasoning: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  /** What the provider's prices make the call cost, in dollars; 0 for models without prices. */
  cost: z.number().default(0),
});

export type StepUsage = z.infer<typeof StepUsageSchema>;

export const emptyStepUsage = (): StepUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

const FormFieldSchema = z.custom<FormField>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { key?: unknown }).key === 'string' &&
    typeof (value as { type?: unknown }).type === 'string',
);

export const HarnessEventSchema = z.discriminatedUnion('type', [
  /** Ralph's: a turn starts work in `session`, before any of the session's own events. */
  Base.extend({
    type: z.literal('turn.started'),
    session: z.string(),
    /** The turn carries on a session an earlier turn started. */
    continued: z.boolean(),
  }),
  /** A session opened, a subagent's included. `parent` is set when the harness says whose child it is. */
  Base.extend({ type: z.literal('session.started'), session: z.string(), parent: z.string().optional() }),
  /** A prompt reached the agent. */
  Base.extend({ type: z.literal('prompt.queued'), text: z.string() }),

  /** `part` names a text or reasoning part across its deltas and end; absent when the harness gives none. */
  Base.extend({ type: z.literal('text.delta'), part: z.string().optional(), text: z.string() }),
  Base.extend({ type: z.literal('text.ended'), part: z.string().optional(), text: z.string() }),
  Base.extend({ type: z.literal('reasoning.delta'), part: z.string().optional(), text: z.string() }),
  /** `text` is absent when the reasoning is empty or not readable. */
  Base.extend({ type: z.literal('reasoning.ended'), part: z.string().optional(), text: z.string().optional() }),

  /** The agent begins a tool call. */
  Base.extend({ type: z.literal('tool.started'), id: z.string(), name: z.string().optional() }),
  /** The call's input is complete and the tool runs. `name` is that of `tool.started` with the same `id`, where there was one. */
  Base.extend({
    type: z.literal('tool.called'),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    /** The id of the call that made this one, as a codemode script does; absent for the agent's own calls. */
    parent: z.string().optional(),
  }),
  /** `output` is the tool's text, parts joined by newlines. A tool that ran and exited non-zero is `success` with its `exit`. */
  Base.extend({
    type: z.literal('tool.finished'),
    id: z.string().optional(),
    name: z.string().optional(),
    parent: z.string().optional(),
    status: z.enum(['success', 'error']),
    exit: z.number().optional(),
    output: z.string().optional(),
  }),

  /** A model call begins; `model` is `provider/id`. */
  Base.extend({ type: z.literal('step.started'), model: z.string().optional() }),
  /** The model's output stream is complete; tools may still run. */
  Base.extend({ type: z.literal('step.streamed') }),
  Base.extend({
    type: z.literal('step.ended'),
    finish: z.string().optional(),
    usage: StepUsageSchema.default(emptyStepUsage),
    files: z.array(z.string()).optional(),
  }),
  /** A model call failed, e.g. because the request overflowed the context window. */
  Base.extend({ type: z.literal('step.failed'), error: z.string().optional() }),
  /** The provider failed and the harness will try again. */
  Base.extend({
    type: z.literal('retry'),
    attempt: z.number().optional(),
    error: z.string().optional(),
    status: z.number().optional(),
  }),

  Base.extend({ type: z.literal('compaction.started') }),
  /** Compaction is still going. */
  Base.extend({ type: z.literal('compaction.progress') }),
  Base.extend({ type: z.literal('compaction.ended') }),

  /** The session's work ended. `error` is the reason, when it did not succeed. */
  Base.extend({
    type: z.literal('execution.ended'),
    outcome: z.enum(['succeeded', 'failed', 'aborted']),
    error: z.string().optional(),
  }),

  /** A form is waiting on an answer. `kind` is what opened it, e.g. `question` or `mcp`. */
  Base.extend({
    type: z.literal('form.opened'),
    session: z.string(),
    form: z.object({
      id: z.string(),
      title: z.string().optional(),
      kind: z.string().optional(),
      fields: z.array(FormFieldSchema).optional(),
    }),
  }),
  /** A form was answered or cancelled, by whoever did. */
  Base.extend({ type: z.literal('form.settled'), id: z.string(), outcome: z.enum(['replied', 'cancelled']) }),
  /** The agent waits for permission to do something. */
  Base.extend({
    type: z.literal('permission.asked'),
    session: z.string(),
    id: z.string(),
    action: z.string(),
    resources: z.array(z.string()).default([]),
    message: z.string().optional(),
    /**
     * The harness puts every tool call to Ralph, not only those its own config marks `ask`: this is the call
     * being judged, which most of the time just runs. Absent where the agent stopped to ask.
     */
    gate: z.boolean().optional(),
  }),

  /** The agent is alive and nothing else is to be recorded: a harness event with no content of its own. */
  Base.extend({ type: z.literal('activity') }),
]);

export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessEventType = HarnessEvent['type'];
export type EventOf<T extends HarnessEventType> = Extract<HarnessEvent, { type: T }>;

export type PermissionRequest = Pick<EventOf<'permission.asked'>, 'id' | 'session' | 'action' | 'resources' | 'message'>;

/**
 * Whether an event proves the agent is alive, resetting the inactivity
 * watchdog. Nearly all do — a fixed allowlist misses quiet phases such as a
 * step starting while a local model is still processing the prompt. Not the
 * provider retries, which mean the agent is stuck (the retry-storm check
 * counts them separately), nor the bookkeeping about sessions and asks.
 */
export function isActivityEvent(event: HarnessEvent): boolean {
  switch (event.type) {
    case 'retry':
    case 'session.started':
    case 'turn.started':
    case 'form.opened':
    case 'form.settled':
      return false;
    default:
      return true;
  }
}
