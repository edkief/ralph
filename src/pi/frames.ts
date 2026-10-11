import { z } from 'zod';

/**
 * What pi's RPC mode writes on stdout, as far as the adapter reads it. Loose
 * objects throughout: pi adds fields between releases, and the pinned version
 * range (see `preflight.ts`) is what keeps the shapes below true.
 */

/** A line pi wrote: an answer to a command (it has `type: "response"`), or an event. */
export const FrameSchema = z.looseObject({ type: z.string() });

export type PiFrame = z.infer<typeof FrameSchema>;

export const ResponseSchema = z.looseObject({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});

export type PiResponse = z.infer<typeof ResponseSchema>;

/**
 * What one model call used. `input` is the prompt without the cached part,
 * `output` includes thinking tokens (pi has no separate figure), and `cost` is
 * an object of dollar amounts of which `total` is the sum.
 */
const UsageSchema = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cost: z.looseObject({ total: z.number().optional() }).optional(),
});

export const MessageSchema = z.looseObject({
  role: z.string(),
  /** A string, or blocks: `{type: "text", text}`, `{type: "thinking", thinking}`, `{type: "toolCall", id, name, arguments}`. */
  content: z.unknown().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  /** `stop`, `length`, `toolUse`, `error` or `aborted`. */
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  timestamp: z.number().optional(),
});

export type PiMessage = z.infer<typeof MessageSchema>;

export const MessageFrameSchema = z.looseObject({ message: MessageSchema });

const ToolCallBlockSchema = z.looseObject({ id: z.string().optional(), name: z.string().optional() });

export const MessageUpdateSchema = z.looseObject({
  message: MessageSchema.optional(),
  assistantMessageEvent: z.looseObject({
    type: z.string(),
    contentIndex: z.number().optional(),
    delta: z.string().optional(),
    /** The finished block's text, on `text_end` and `thinking_end`. */
    content: z.string().optional(),
    partial: MessageSchema.optional(),
    toolCall: ToolCallBlockSchema.optional(),
  }),
});

const ToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() })).optional(),
});

export const ToolStartSchema = z.looseObject({
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const ToolEndSchema = z.looseObject({
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  result: ToolResultSchema.optional(),
  isError: z.boolean().optional(),
});

export const AgentEndSchema = z.looseObject({ messages: z.array(MessageSchema).optional() });

export const CompactionEndSchema = z.looseObject({
  reason: z.string().optional(),
  /** Absent when compaction was aborted or failed. */
  result: z.unknown().optional(),
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  errorMessage: z.string().optional(),
});

export const RetryStartSchema = z.looseObject({
  attempt: z.number().optional(),
  maxAttempts: z.number().optional(),
  delayMs: z.number().optional(),
  errorMessage: z.string().optional(),
});

export const RetryEndSchema = z.looseObject({
  success: z.boolean().optional(),
  finalError: z.string().optional(),
});

export const UiRequestSchema = z.looseObject({
  id: z.string(),
  method: z.string(),
});

/** The text of a message's content: a string as is, text blocks joined. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []))
    .join('');
}
