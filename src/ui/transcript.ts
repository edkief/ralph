import type { EventOf, HarnessEvent } from '../harness/events.js';
import type { TranscriptEntry } from './types.js';

/** Tool input and output shown in the UI; the rest is in the event file. */
const MAX_OUTPUT = 20_000;
/** What the agent wrote or was sent, likewise. */
const MAX_TEXT = 100_000;

/**
 * Folds an iteration's event stream into transcript entries: what the agent
 * said, the tools it ran with their output, model calls with their tokens,
 * and notable moments such as retries or compaction.
 *
 * `push` returns the entries the event added or changed, so a live view can
 * send just those. An entry keeps its id as it changes, e.g. a text part
 * growing delta by delta.
 *
 * Every entry of the session is kept, so a whole round can be read back; long
 * texts and tool input and output are clipped, so one entry stays small. The
 * live feed holds one builder for the session in progress, whoever watches.
 */
export class TranscriptBuilder {
  private readonly entries = new Map<string, TranscriptEntry>();
  /** The turn's own sessions, as Ralph recorded them: a retry starts another. */
  private readonly ownSessions = new Set<string>();
  /**
   * For an event file recorded before Ralph named the turn's sessions: the
   * first session seen stands for the turn, and any other for a subagent.
   */
  private firstSession: string | undefined;
  private seq = 0;
  /** Open text or reasoning parts that arrived without ids, by session. */
  private readonly anonymous = new Map<string, string>();


  get all(): TranscriptEntry[] {
    return [...this.entries.values()];
  }

  push(event: HarnessEvent): TranscriptEntry[] {
    const session = event.session;
    const time = event.created !== undefined ? { time: event.created } : {};
    if (event.type === 'turn.started') {
      if (this.ownSessions.has(event.session)) return [];
      const retry = this.ownSessions.size > 0;
      this.ownSessions.add(event.session);
      return retry ? this.notice(time, 'warn', 'the turn started over in a fresh session') : [];
    }
    if (this.ownSessions.size === 0) this.firstSession ??= session;
    if (event.type === 'session.started') return [];
    const own = this.ownSessions.size > 0 ? session !== undefined && this.ownSessions.has(session) : session === this.firstSession;
    const base = {
      ...time,
      ...(session && !own ? { subagent: true } : {}),
    };

    switch (event.type) {
      case 'permission.asked': {
        // A call being judged, which the tool's own entry already shows.
        if (event.gate) return [];
        const what = [event.action, ...event.resources].join(' ');
        return this.add({ ...base, id: this.nextId('permission'), kind: 'notice', level: 'info', text: `permission asked: ${what}` });
      }
      // Ralph cancels every form: nobody is there to answer it.
      case 'form.opened': {
        const what = [event.form.title, `(${event.form.kind ?? 'form'})`].filter(Boolean).join(' ');
        return this.add({ ...base, id: this.nextId('form'), kind: 'notice', level: 'info', text: `form cancelled: ${what}` });
      }
      case 'prompt.queued':
        return event.text ? this.add({ ...base, id: this.nextId('prompt'), kind: 'prompt', text: clip(event.text, MAX_TEXT) }) : [];
      case 'text.delta':
      case 'reasoning.delta': {
        if (!event.text) return [];
        const kind = event.type === 'text.delta' ? 'text' : 'reasoning';
        const id = this.partId(kind, session, event.part, false);
        const current = this.entries.get(id);
        const before = current && 'text' in current ? current.text : '';
        // Full already: the rest arrives with the part's end, clipped.
        if (before.length >= MAX_TEXT) return [];
        const text = before + event.text;
        return this.add(
          kind === 'text'
            ? { ...base, id, kind, text, done: false }
            : { ...base, id, kind, text },
        );
      }
      case 'text.ended': {
        const id = this.partId('text', session, event.part, true);
        if (!event.text && !this.entries.has(id)) return [];
        return this.add({ ...base, id, kind: 'text', text: clip(event.text, MAX_TEXT), done: true });
      }
      case 'reasoning.ended': {
        const id = this.partId('reasoning', session, event.part, true);
        // Reasoning often arrives encrypted, with no readable text.
        if (!event.text) return [];
        return this.add({ ...base, id, kind: 'reasoning', text: clip(event.text, MAX_TEXT) });
      }
      case 'tool.started':
        return this.add({ ...base, id: `tool:${event.id}`, kind: 'tool', name: event.name ?? 'tool', status: 'running' });
      case 'tool.called': {
        const id = event.id ? `tool:${event.id}` : this.nextId('tool');
        const current = this.entries.get(id);
        const name = current?.kind === 'tool' ? current.name : (event.name ?? 'tool');
        return this.add({
          ...(current ?? {}),
          ...base,
          id,
          kind: 'tool',
          name,
          status: current?.kind === 'tool' ? current.status : 'running',
          ...(event.parent ? { parent: `tool:${event.parent}` } : {}),
          ...(event.input ? { input: clipInput(event.input) } : {}),
        });
      }
      case 'tool.finished': {
        const id = event.id ? `tool:${event.id}` : this.nextId('tool');
        const current = this.entries.get(id);
        return this.add({
          ...(current?.kind === 'tool' ? current : { name: event.name ?? 'tool', ...(event.parent ? { parent: `tool:${event.parent}` } : {}) }),
          ...base,
          id,
          kind: 'tool',
          // A tool that ran and exited non-zero failed, whatever the harness made of the call.
          status: event.status === 'success' && (event.exit === undefined || event.exit === 0) ? 'success' : 'error',
          ...(event.output ? { output: clip(event.output) } : {}),
          ...(event.exit !== undefined ? { exit: event.exit } : {}),
        });
      }
      case 'step.ended':
        return this.add({
          ...base,
          id: this.nextId('step'),
          kind: 'step',
          tokens: {
            input: event.usage.input,
            output: event.usage.output,
            reasoning: event.usage.reasoning,
            cacheRead: event.usage.cacheRead,
          },
          cost: event.usage.cost,
          ...(event.finish ? { finish: event.finish } : {}),
        });
      case 'step.failed':
        return this.notice(base, 'error', `model call failed: ${event.error ?? 'unknown error'}`);
      case 'retry': {
        const error = event.error ?? 'unknown provider error';
        return this.notice(base, 'warn', `provider retry${event.attempt ? ` ${event.attempt}` : ''}: ${error}`);
      }
      case 'compaction.started':
        return this.notice(base, 'info', 'compacting the conversation to fit the context window');
      case 'compaction.ended':
        return this.notice(base, 'info', 'conversation compacted');
      case 'execution.ended':
        return this.executionNotice(base, event);
      default:
        return [];
    }
  }

  private executionNotice(base: Pick<TranscriptEntry, 'time' | 'subagent'>, event: EventOf<'execution.ended'>): TranscriptEntry[] {
    switch (event.outcome) {
      case 'succeeded':
        return base.subagent ? [] : this.notice(base, 'info', 'execution finished');
      case 'failed':
        return this.notice(base, 'error', event.error ?? 'execution failed');
      case 'aborted':
        return this.notice(base, 'warn', 'execution interrupted');
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
   * A text or reasoning part is named by the harness. One that gives no name
   * lasts from its first delta to its end.
   */
  private partId(
    kind: 'text' | 'reasoning',
    session: string | undefined,
    part: string | undefined,
    ended: boolean,
  ): string {
    if (part !== undefined) return `${kind}:${session ?? ''}:${part}`;
    const key = `${kind}:${session ?? ''}`;
    const id = this.anonymous.get(key) ?? this.nextId(kind);
    if (ended) this.anonymous.delete(key);
    else this.anonymous.set(key, id);
    return id;
  }
}

function clip(text: string, max: number = MAX_OUTPUT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** A tool's input with long values cut: a written file's content arrives whole. */
function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const clipped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') clipped[key] = clip(value);
    else if (value !== null && typeof value === 'object') {
      const json = JSON.stringify(value);
      clipped[key] = json.length <= MAX_OUTPUT ? value : clip(json);
    } else clipped[key] = value;
  }
  return clipped;
}
