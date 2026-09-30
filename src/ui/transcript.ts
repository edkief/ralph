import { z } from 'zod';
import {
  ExecutionEndedSchema,
  PermissionRequestSchema,
  RetryScheduledSchema,
  StepEndedSchema,
  StepFailedSchema,
  TextEndedSchema,
  ToolCalledSchema,
  ToolInputStartedSchema,
  ToolResultSchema,
  errorMessage,
  readData,
  sessionIdOf,
  toolName,
  type OpencodeEvent,
} from '../opencode/events.js';
import type { TranscriptEntry } from './types.js';

/** Identifies a text or reasoning part across its start, deltas and end. */
const PartSchema = z.looseObject({
  assistantMessageID: z.string().optional(),
  ordinal: z.number().optional(),
  delta: z.string().optional(),
  text: z.string().optional(),
});

const PromptSchema = z.looseObject({
  item: z.looseObject({ payload: z.looseObject({ text: z.string().optional() }).optional() }).optional(),
});

/** Tool output shown in the UI; the rest is in the event file. */
const MAX_OUTPUT = 20_000;

/**
 * Folds an iteration's event stream into transcript entries: what the agent
 * said, the tools it ran with their output, model calls with their tokens,
 * and notable moments such as retries or compaction.
 *
 * `push` returns the entries the event added or changed, so a live view can
 * send just those. An entry keeps its id as it changes, e.g. a text part
 * growing delta by delta.
 */
export class TranscriptBuilder {
  private readonly entries = new Map<string, TranscriptEntry>();
  private mainSession: string | undefined;
  private seq = 0;
  /** Open text or reasoning parts that arrived without ids, by session. */
  private readonly anonymous = new Map<string, string>();

  get all(): TranscriptEntry[] {
    return [...this.entries.values()];
  }

  push(event: OpencodeEvent): TranscriptEntry[] {
    const session = sessionIdOf(event);
    if (event.type === 'session.created') {
      this.mainSession ??= session;
      return [];
    }
    this.mainSession ??= session;
    const base = {
      ...(typeof event['created'] === 'number' ? { time: event['created'] } : {}),
      ...(session && session !== this.mainSession ? { subagent: true } : {}),
    };

    if (event.type.includes('permission')) {
      const request = readData(event, PermissionRequestSchema);
      if (!request) return [];
      const what = [request.action, ...request.resources].join(' ');
      return this.add({ ...base, id: this.nextId('permission'), kind: 'notice', level: 'info', text: `permission asked: ${what}` });
    }

    switch (event.type) {
      case 'session.inbox.enqueued': {
        const text = readData(event, PromptSchema)?.item?.payload?.text;
        return text ? this.add({ ...base, id: this.nextId('prompt'), kind: 'prompt', text }) : [];
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const part = readData(event, PartSchema);
        if (!part?.delta) return [];
        const kind = event.type === 'session.text.delta' ? 'text' : 'reasoning';
        const id = this.partId(kind, session, part, false);
        const current = this.entries.get(id);
        const text = (current && 'text' in current ? current.text : '') + part.delta;
        return this.add(
          kind === 'text'
            ? { ...base, id, kind, text, done: false }
            : { ...base, id, kind, text },
        );
      }
      case 'session.text.ended': {
        const part = readData(event, PartSchema);
        const text = readData(event, TextEndedSchema)?.text ?? '';
        const id = this.partId('text', session, part, true);
        if (!text && !this.entries.has(id)) return [];
        return this.add({ ...base, id, kind: 'text', text, done: true });
      }
      case 'session.reasoning.ended': {
        const part = readData(event, PartSchema);
        const id = this.partId('reasoning', session, part, true);
        // Reasoning often arrives encrypted, with no readable text.
        if (!part?.text) return [];
        return this.add({ ...base, id, kind: 'reasoning', text: part.text });
      }
      case 'session.tool.input.started': {
        const data = readData(event, ToolInputStartedSchema);
        if (!data?.id) return [];
        return this.add({ ...base, id: `tool:${data.id}`, kind: 'tool', name: data.name ?? 'tool', status: 'running' });
      }
      case 'session.tool.called': {
        const data = readData(event, ToolCalledSchema);
        const id = data?.id ? `tool:${data.id}` : this.nextId('tool');
        const current = this.entries.get(id);
        const name = current?.kind === 'tool' ? current.name : toolName(event);
        return this.add({
          ...(current ?? {}),
          ...base,
          id,
          kind: 'tool',
          name,
          status: current?.kind === 'tool' ? current.status : 'running',
          ...(data?.input ? { input: data.input } : {}),
        });
      }
      case 'session.tool.success':
      case 'session.tool.error':
      case 'session.tool.failed': {
        const data = readData(event, ToolResultSchema);
        const id = data?.id ? `tool:${data.id}` : this.nextId('tool');
        const current = this.entries.get(id);
        const output = (data?.content ?? []).flatMap((part) => (part.text ? [part.text] : [])).join('\n');
        const exit = data?.metadata?.exit;
        return this.add({
          ...(current?.kind === 'tool' ? current : { name: toolName(event) }),
          ...base,
          id,
          kind: 'tool',
          status: event.type === 'session.tool.success' && (exit === undefined || exit === 0) ? 'success' : 'error',
          ...(output ? { output: clip(output) } : {}),
          ...(exit !== undefined ? { exit } : {}),
        });
      }
      case 'session.step.ended': {
        const data = readData(event, StepEndedSchema);
        const tokens = data?.tokens;
        return this.add({
          ...base,
          id: this.nextId('step'),
          kind: 'step',
          tokens: {
            input: tokens?.input ?? 0,
            output: tokens?.output ?? 0,
            reasoning: tokens?.reasoning ?? 0,
            cacheRead: tokens?.cache?.read ?? 0,
          },
          cost: data?.cost ?? 0,
          ...(data?.finish ? { finish: data.finish } : {}),
        });
      }
      case 'session.step.failed': {
        const error = errorMessage(readData(event, StepFailedSchema)?.error) ?? 'unknown error';
        return this.notice(base, 'error', `model call failed: ${error}`);
      }
      case 'session.retry.scheduled': {
        const data = readData(event, RetryScheduledSchema);
        const error = data?.error?.message ?? data?.error?.type ?? 'unknown provider error';
        return this.notice(base, 'warn', `provider retry${data?.attempt ? ` ${data.attempt}` : ''}: ${error}`);
      }
      case 'session.compaction.started':
        return this.notice(base, 'info', 'compacting the conversation to fit the context window');
      case 'session.compaction.ended':
        return this.notice(base, 'info', 'conversation compacted');
      case 'session.execution.succeeded':
        return base.subagent ? [] : this.notice(base, 'info', 'execution finished');
      case 'session.execution.failed': {
        const error = errorMessage(readData(event, ExecutionEndedSchema)?.error) ?? 'execution failed';
        return this.notice(base, 'error', error);
      }
      case 'session.execution.aborted':
        return this.notice(base, 'warn', 'execution interrupted');
      default:
        return [];
    }
  }

  private notice(
    base: Pick<TranscriptEntry, 'time' | 'subagent'>,
    level: 'info' | 'warn' | 'error',
    text: string,
  ): TranscriptEntry[] {
    return this.add({ ...base, id: this.nextId('notice'), kind: 'notice', level, text });
  }

  private add(entry: TranscriptEntry): TranscriptEntry[] {
    this.entries.set(entry.id, entry);
    return [entry];
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}:${this.seq}`;
  }

  /**
   * A text or reasoning part is named by its message and ordinal. Test
   * servers and older opencode send neither, so a part without them lasts
   * from its first delta to its end.
   */
  private partId(
    kind: 'text' | 'reasoning',
    session: string | undefined,
    part: z.infer<typeof PartSchema> | undefined,
    ended: boolean,
  ): string {
    if (part?.assistantMessageID !== undefined) {
      return `${kind}:${session ?? ''}:${part.assistantMessageID}:${part.ordinal ?? 0}`;
    }
    const key = `${kind}:${session ?? ''}`;
    const id = this.anonymous.get(key) ?? this.nextId(kind);
    if (ended) this.anonymous.delete(key);
    else this.anonymous.set(key, id);
    return id;
  }
}

function clip(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)`;
}
