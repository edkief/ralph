import { z } from 'zod';
import type { EventOf, HarnessEvent } from '../harness/vocab.js';
import type { OpencodeFrame } from './frames.js';

/** The tokens a step reports; opencode counts reasoning apart from output. */
const TokensSchema = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  reasoning: z.number().optional(),
  cache: z.looseObject({ read: z.number().optional(), write: z.number().optional() }).optional(),
});

const TextSchema = z.looseObject({
  assistantMessageID: z.string().optional(),
  ordinal: z.number().optional(),
  delta: z.string().optional(),
  text: z.string().optional(),
});

const InboxSchema = z.looseObject({
  item: z.looseObject({ payload: z.looseObject({ text: z.string().optional() }).optional() }).optional(),
});

const ToolSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
  metadata: z.looseObject({ exit: z.number().optional() }).optional(),
});

const StepStartedSchema = z.looseObject({
  model: z.looseObject({ id: z.string().optional(), providerID: z.string().optional() }).optional(),
});

const StepEndedSchema = z.looseObject({
  finish: z.string().optional(),
  tokens: TokensSchema.optional(),
  cost: z.number().optional(),
  files: z.array(z.string()).optional(),
});

const ErrorOnlySchema = z.looseObject({ error: z.unknown().optional() });

const RetrySchema = z.looseObject({
  attempt: z.number().optional(),
  error: z
    .looseObject({ type: z.string().optional(), message: z.string().optional(), status: z.number().optional() })
    .optional(),
});

const TurnStartedSchema = z.looseObject({ sessionID: z.string() });

const SessionCreatedSchema = z.looseObject({ sessionID: z.string(), parentID: z.string().optional() });

const PermissionSchema = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  action: z.string(),
  resources: z.array(z.string()).default([]),
  message: z.string().optional(),
});

const FormCreatedSchema = z.looseObject({
  form: z.looseObject({
    id: z.string(),
    sessionID: z.string(),
    title: z.string().optional(),
    metadata: z.looseObject({ kind: z.string().optional() }).optional(),
    fields: z.array(z.looseObject({ key: z.string(), type: z.string() })).optional(),
  }),
});

const FormSettledSchema = z.looseObject({ id: z.string() });

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

/** The session a frame belongs to; a form frame names it on the form. */
function sessionOf(data: unknown): string | undefined {
  const record = data as { sessionID?: unknown; form?: { sessionID?: unknown } } | undefined;
  if (typeof record?.sessionID === 'string') return record.sessionID;
  return typeof record?.form?.sessionID === 'string' ? record.form.sessionID : undefined;
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T | undefined {
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** `provider/id`, or the bare id where the provider is not named. */
function modelName(model: { id?: string | undefined; providerID?: string | undefined } | undefined): string | undefined {
  if (!model?.id) return undefined;
  return model.providerID ? `${model.providerID}/${model.id}` : model.id;
}

/** opencode names a part by its message and ordinal; older servers send neither. */
function partOf(data: z.infer<typeof TextSchema> | undefined): { part?: string } {
  return data?.assistantMessageID !== undefined ? { part: `${data.assistantMessageID}:${data.ordinal ?? 0}` } : {};
}

/**
 * opencode's frames, translated into Ralph's event vocabulary. This is the
 * adapter's mapper for the live stream and the legacy reader of history files
 * written before the vocabulary existed, so what is shown live and what is
 * shown afterwards cannot drift apart.
 *
 * One translator follows one stream: it correlates a tool's name, sent when
 * its input starts, with the later frames of the same call.
 */
export class OpencodeTranslator {
  private readonly toolNames = new Map<string, string>();

  push(frame: OpencodeFrame): HarnessEvent[] {
    const { type, data } = frame;
    const session = sessionOf(data);
    const at = {
      ...(typeof frame['created'] === 'number' ? { created: frame['created'] } : {}),
      ...(session ? { session } : {}),
    };
    // A frame that proves the agent is alive but says nothing else.
    const activity = (): HarnessEvent[] => [{ type: 'activity', ...at }];

    // Ralph's own, mixed into the same file by the old recorder.
    if (type === 'ralph.turn.started') {
      const started = parse(TurnStartedSchema, data);
      const continued = (data as { continued?: unknown } | undefined)?.continued === true;
      return started ? [{ type: 'turn.started', ...at, session: started.sessionID, continued }] : [];
    }

    if (type.includes('permission')) {
      const request = parse(PermissionSchema, data);
      if (!request) return activity();
      return [
        {
          type: 'permission.asked',
          ...at,
          session: request.sessionID,
          id: request.id,
          action: request.action,
          resources: request.resources,
          ...(request.message !== undefined ? { message: request.message } : {}),
        },
      ];
    }

    switch (type) {
      case 'session.created': {
        const created = parse(SessionCreatedSchema, data);
        if (!created) return [];
        return [
          {
            type: 'session.started',
            ...at,
            session: created.sessionID,
            ...(created.parentID ? { parent: created.parentID } : {}),
          },
        ];
      }
      case 'session.inbox.enqueued': {
        const text = parse(InboxSchema, data)?.item?.payload?.text;
        return text ? [{ type: 'prompt.queued', ...at, text }] : activity();
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const text = parse(TextSchema, data);
        if (!text?.delta) return activity();
        return [{ type: type === 'session.text.delta' ? 'text.delta' : 'reasoning.delta', ...at, ...partOf(text), text: text.delta }];
      }
      case 'session.text.ended': {
        const text = parse(TextSchema, data);
        return [{ type: 'text.ended', ...at, ...partOf(text), text: text?.text ?? '' }];
      }
      case 'session.reasoning.ended': {
        const text = parse(TextSchema, data);
        return [{ type: 'reasoning.ended', ...at, ...partOf(text), ...(text?.text ? { text: text.text } : {}) }];
      }
      case 'session.tool.input.started': {
        const tool = parse(ToolSchema, data);
        if (!tool?.id) return activity();
        if (tool.name) this.toolNames.set(tool.id, tool.name);
        return [{ type: 'tool.started', ...at, id: tool.id, ...(tool.name ? { name: tool.name } : {}) }];
      }
      case 'session.tool.called': {
        const tool = parse(ToolSchema, data);
        const name = this.nameOf(tool);
        return [
          {
            type: 'tool.called',
            ...at,
            ...(tool?.id ? { id: tool.id } : {}),
            ...(name ? { name } : {}),
            ...(tool?.input ? { input: tool.input } : {}),
          },
        ];
      }
      case 'session.tool.success':
      case 'session.tool.error':
      case 'session.tool.failed': {
        const tool = parse(ToolSchema, data);
        const name = this.nameOf(tool);
        const output = (tool?.content ?? []).flatMap((part) => (part.text ? [part.text] : [])).join('\n');
        const exit = tool?.metadata?.exit;
        const event: EventOf<'tool.finished'> = {
          type: 'tool.finished',
          ...at,
          ...(tool?.id ? { id: tool.id } : {}),
          ...(name ? { name } : {}),
          status: type === 'session.tool.success' ? 'success' : 'error',
          ...(exit !== undefined ? { exit } : {}),
          ...(output ? { output } : {}),
        };
        return [event];
      }
      case 'session.step.started': {
        const model = modelName(parse(StepStartedSchema, data)?.model);
        return [{ type: 'step.started', ...at, ...(model ? { model } : {}) }];
      }
      case 'session.step.streamed':
        return [{ type: 'step.streamed', ...at }];
      case 'session.step.ended': {
        const step = parse(StepEndedSchema, data);
        const tokens = step?.tokens;
        return [
          {
            type: 'step.ended',
            ...at,
            ...(step?.finish ? { finish: step.finish } : {}),
            usage: {
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              reasoning: tokens?.reasoning ?? 0,
              cacheRead: tokens?.cache?.read ?? 0,
              cacheWrite: tokens?.cache?.write ?? 0,
              cost: step?.cost ?? 0,
            },
            ...(step?.files ? { files: step.files } : {}),
          },
        ];
      }
      case 'session.step.failed': {
        const error = errorMessage(parse(ErrorOnlySchema, data)?.error);
        return [{ type: 'step.failed', ...at, ...(error ? { error } : {}) }];
      }
      case 'session.retry.scheduled': {
        const retry = parse(RetrySchema, data);
        const error = retry?.error?.message ?? retry?.error?.type;
        return [
          {
            type: 'retry',
            ...at,
            ...(retry?.attempt !== undefined ? { attempt: retry.attempt } : {}),
            ...(error ? { error } : {}),
            ...(retry?.error?.status !== undefined ? { status: retry.error.status } : {}),
          },
        ];
      }
      case 'session.compaction.started':
        return [{ type: 'compaction.started', ...at }];
      case 'session.compaction.delta':
        return [{ type: 'compaction.progress', ...at }];
      case 'session.compaction.ended':
        return [{ type: 'compaction.ended', ...at }];
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.aborted': {
        const error = errorMessage(parse(ErrorOnlySchema, data)?.error);
        const outcome = type.slice('session.execution.'.length) as 'succeeded' | 'failed' | 'aborted';
        return [{ type: 'execution.ended', ...at, outcome, ...(error ? { error } : {}) }];
      }
      case 'form.created': {
        const form = parse(FormCreatedSchema, data)?.form;
        if (!form) return activity();
        const kind = form.metadata?.kind;
        return [
          {
            type: 'form.opened',
            ...at,
            session: form.sessionID,
            form: {
              id: form.id,
              ...(form.title !== undefined ? { title: form.title } : {}),
              ...(kind ? { kind } : {}),
              ...(form.fields ? { fields: form.fields as NonNullable<EventOf<'form.opened'>['form']['fields']> } : {}),
            },
          },
        ];
      }
      case 'form.replied':
      case 'form.cancelled': {
        const settled = parse(FormSettledSchema, data);
        if (!settled) return [];
        return [{ type: 'form.settled', ...at, id: settled.id, outcome: type === 'form.replied' ? 'replied' : 'cancelled' }];
      }
      default:
        // Any other session frame is the agent working; the rest is the server's own business.
        return type.startsWith('session.') ? activity() : [];
    }
  }

  /** The tool's name: the one its input started with, else what the frame itself says. */
  private nameOf(tool: z.infer<typeof ToolSchema> | undefined): string | undefined {
    return (tool?.id ? this.toolNames.get(tool.id) : undefined) ?? tool?.tool ?? tool?.name;
  }
}
