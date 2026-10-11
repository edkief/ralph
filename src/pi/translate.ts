import type { EventOf, HarnessEvent, StepUsage } from '../harness/events.js';
import {
  AgentEndSchema,
  CompactionEndSchema,
  SettledSchema,
  MessageFrameSchema,
  MessageUpdateSchema,
  RetryEndSchema,
  RetryStartSchema,
  ToolEndSchema,
  ToolStartSchema,
  textOf,
  type PiFrame,
  type PiMessage,
} from './frames.js';

const EXIT_LINE = /Command exited with code (\d+)\s*$/;

export interface TranslatorOptions {
  /** Epoch milliseconds, for events; injectable for tests. */
  now?: () => number;
}

/**
 * One pi session's frames, translated into Ralph's event vocabulary.
 *
 * `agent_end` ends one attempt: a failed attempt may be followed by `auto_retry_start` or by `compaction_start`
 * (an overflow that is recovered by compacting and running again), and the attempts after that are runs of their
 * own. `agent_settled` comes once none follows, so it is what ends the execution.
 *
 * While a retry is pending the failed attempt is kept out of the events: its error is the `retry` event's, and
 * the watchdog counts retries only while nothing else shows the agent is alive.
 */
export class PiTranslator {
  private readonly now: () => number;
  private readonly toolNames = new Map<string, string>();
  /** Files the tools wrote since the last model call ended. */
  private files = new Set<string>();
  /** The path an `edit` or `write` call is for, until the call ends. */
  private readonly writing = new Map<string, string>();

  private isRunning = false;
  private isCompacting = false;
  /** Assistant messages begun so far: with a content index, it names a block (pi 1.x sends no message timestamp on updates). */
  private messages = 0;
  private last: Pick<PiMessage, 'stopReason' | 'errorMessage'> | undefined;
  /** A failed model call, until it is known not to be retried. */
  private heldFailure: HarnessEvent | undefined;
  /** After `auto_retry_start`, until the retried attempt shows progress. */
  private retrying = false;
  private deferredStep: HarnessEvent | undefined;
  private finalError: string | undefined;
  /** The turn was asked to stop, so a failure that follows is the stop. */
  private stopRequested = false;

  constructor(
    private readonly session: string,
    options: TranslatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The agent has begun a run and its execution has not ended. */
  get running(): boolean {
    return this.isRunning;
  }

  /** A compaction is under way, whatever started it. */
  get compacting(): boolean {
    return this.isCompacting;
  }

  /** A prompt was accepted: the run it starts has not reported in yet, but the agent is at work. */
  markStarting(): void {
    this.isRunning = true;
    this.stopRequested = false;
  }

  /** The turn is being stopped; see `settle`. */
  markStopping(): void {
    this.stopRequested = true;
  }

  push(frame: PiFrame): HarnessEvent[] {
    switch (frame.type) {
      case 'agent_start': {
        this.isRunning = true;
        return this.retrying ? [] : [this.event({ type: 'activity' })];
      }
      case 'turn_start':
        return this.retrying ? [] : [this.event({ type: 'activity' })];
      case 'turn_end':
        // The end of a turn that failed is not a sign of life: a retry follows, and counts only if nothing else does.
        return this.retrying || MessageFrameSchema.safeParse(frame).data?.message.stopReason === 'error' ? [] : [this.event({ type: 'activity' })];
      case 'message_start':
        return this.messageStart(frame);
      case 'message_update':
        return this.messageUpdate(frame);
      case 'message_end':
        return this.messageEnd(frame);
      case 'tool_execution_start': {
        const tool = ToolStartSchema.safeParse(frame).data;
        if (tool?.toolCallId && tool.toolName) this.toolNames.set(tool.toolCallId, tool.toolName);
        const path = tool?.args?.['path'];
        if (tool?.toolCallId && (tool.toolName === 'edit' || tool.toolName === 'write') && typeof path === 'string') {
          this.writing.set(tool.toolCallId, path);
        }
        return [
          ...this.progress(),
          this.event({
            type: 'tool.called',
            ...(tool?.toolCallId ? { id: tool.toolCallId } : {}),
            ...(tool?.toolName ? { name: tool.toolName } : {}),
            ...(tool?.args ? { input: tool.args } : {}),
          }),
        ];
      }
      case 'tool_execution_end':
        return [this.toolEnd(frame)];
      case 'compaction_start': {
        this.isCompacting = true;
        // The attempt that overflowed is a real, failed call.
        return [...this.takeFailure(), this.event({ type: 'compaction.started' })];
      }
      case 'compaction_end':
        return this.compactionEnd(frame);
      case 'auto_retry_start': {
        const retry = RetryStartSchema.safeParse(frame).data;
        this.heldFailure = undefined;
        this.retrying = true;
        const status = retry?.errorMessage?.match(/^(\d{3})\b/)?.[1];
        return [
          this.event({
            type: 'retry',
            ...(retry?.attempt !== undefined ? { attempt: retry.attempt } : {}),
            ...(retry?.errorMessage ? { error: retry.errorMessage } : {}),
            ...(status ? { status: Number(status) } : {}),
          }),
        ];
      }
      case 'auto_retry_end': {
        const end = RetryEndSchema.safeParse(frame).data;
        if (end?.success === false) {
          // The retries are the record of the failures, and the error is the execution's: a failed call here would
          // show the watchdog an agent that is alive.
          this.finalError = end.finalError;
          this.heldFailure = undefined;
          return [];
        }
        return [this.event({ type: 'activity' })];
      }
      case 'agent_end':
        return this.agentEnd(frame);
      case 'agent_settled':
        return this.settle(undefined, SettledSchema.safeParse(frame).data?.aborted === true);
      case 'entry_appended':
        // pi's own record keeping, such as leaving a failed attempt out of the context: no sign of life.
        return [];
      default:
        // tool_execution_update, queue_update, extension_error and what a later pi adds: the agent is alive.
        return [this.event({ type: 'activity' })];
    }
  }

  /**
   * End the execution: pi settled, or its process died. How it ended is that of the last model call; with
   * nothing run, as when the process died, `error` says why. `aborted` is pi's word that the run was stopped.
   */
  settle(error?: string, aborted = false): HarnessEvent[] {
    if (!this.isRunning) return [];
    // pi 1.x ends a call it cut short with an error ("This operation was aborted"): that is the stop, not a failure.
    const cutShort = (this.stopRequested || aborted) && error === undefined;
    const failure = cutShort ? [] : this.takeFailure();
    this.heldFailure = undefined;
    const stop = cutShort && this.last?.stopReason === 'error' ? 'aborted' : this.last?.stopReason;
    const message = error ?? (cutShort ? undefined : this.finalError) ?? (stop === 'error' ? (this.last?.errorMessage ?? 'the model call failed') : undefined);
    // A retry cut off by the stop ends in an error of its own.
    const stopped = cutShort && message !== undefined;
    const outcome: EventOf<'execution.ended'>['outcome'] =
      stopped ? 'aborted' : message !== undefined ? 'failed' : stop === 'aborted' || aborted ? 'aborted' : 'succeeded';
    this.stopRequested = false;
    this.isRunning = false;
    this.retrying = false;
    this.deferredStep = undefined;
    this.finalError = undefined;
    this.last = undefined;
    return [...failure, this.event({ type: 'execution.ended', outcome, ...(message !== undefined && !stopped ? { error: message } : {}) })];
  }

  /** The process died: end any execution under way as failed. */
  exited(reason: string): HarnessEvent[] {
    this.isCompacting = false;
    return this.settle(reason);
  }

  private agentEnd(frame: PiFrame): HarnessEvent[] {
    const messages = AgentEndSchema.safeParse(frame).data?.messages ?? [];
    const lastAssistant = messages.findLast((message) => message.role === 'assistant');
    if (lastAssistant) this.last = { stopReason: lastAssistant.stopReason, errorMessage: lastAssistant.errorMessage };
    // A retry or an overflow recovery may follow; `agent_settled` says when none does.
    return [];
  }

  private compactionEnd(frame: PiFrame): HarnessEvent[] {
    this.isCompacting = false;
    const end = CompactionEndSchema.safeParse(frame).data;
    const done = end?.result !== undefined && end.result !== null && !end.aborted;
    return [done ? this.event({ type: 'compaction.ended' }) : this.event({ type: 'activity' })];
  }

  private messageStart(frame: PiFrame): HarnessEvent[] {
    const message = MessageFrameSchema.safeParse(frame).data?.message;
    if (message?.role !== 'assistant') return [];
    this.messages += 1;
    const model = message.provider && message.model ? `${message.provider}/${message.model}` : message.model;
    const step = this.event({ type: 'step.started', ...(model ? { model } : {}) });
    if (this.retrying) {
      this.deferredStep = step;
      return [];
    }
    return [step];
  }

  private messageUpdate(frame: PiFrame): HarnessEvent[] {
    const update = MessageUpdateSchema.safeParse(frame).data;
    const inner = update?.assistantMessageEvent;
    if (!inner) return [this.event({ type: 'activity' })];
    const index = inner.contentIndex ?? 0;
    const part = `${this.messages}:${index}`;
    const block = Array.isArray(inner.partial?.content) ? (inner.partial.content[index] as { thinking?: string; text?: string } | undefined) : undefined;

    switch (inner.type) {
      case 'text_delta':
        return [...this.progress(), this.event({ type: 'text.delta', part, text: inner.delta ?? '' })];
      case 'text_end':
        return [...this.progress(), this.event({ type: 'text.ended', part, text: inner.content ?? block?.text ?? '' })];
      case 'thinking_delta':
        return [...this.progress(), this.event({ type: 'reasoning.delta', part, text: inner.delta ?? '' })];
      case 'thinking_end': {
        const text = inner.content ?? block?.thinking;
        return [...this.progress(), this.event({ type: 'reasoning.ended', part, ...(text ? { text } : {}) })];
      }
      case 'toolcall_start': {
        const block = Array.isArray(inner.partial?.content) ? (inner.partial.content[index] as { id?: string; name?: string } | undefined) : undefined;
        const id = inner.id ?? block?.id;
        const name = inner.toolName ?? block?.name;
        if (!id) return [...this.progress(), this.event({ type: 'activity' })];
        if (name) this.toolNames.set(id, name);
        return [...this.progress(), this.event({ type: 'tool.started', id, ...(name ? { name } : {}) })];
      }
      case 'start':
      case 'text_start':
      case 'thinking_start':
        return [this.event({ type: 'activity' })];
      default:
        return [...this.progress(), this.event({ type: 'activity' })];
    }
  }

  private messageEnd(frame: PiFrame): HarnessEvent[] {
    const message = MessageFrameSchema.safeParse(frame).data?.message;
    if (!message) return [this.event({ type: 'activity' })];

    if (message.role === 'user') {
      const text = textOf(message.content);
      return [text ? this.event({ type: 'prompt.queued', text }) : this.event({ type: 'activity' })];
    }
    if (message.role !== 'assistant') return [this.event({ type: 'activity' })];

    this.last = { stopReason: message.stopReason, errorMessage: message.errorMessage };
    if (message.stopReason === 'error') {
      // Whether this is the end of the turn or only of an attempt is known once `agent_end` has passed.
      this.heldFailure = this.event({ type: 'step.failed', ...(message.errorMessage ? { error: message.errorMessage } : {}) });
      // A retried attempt that fails again shows nothing: its error is the next retry's.
      this.deferredStep = undefined;
      return [];
    }
    if (message.stopReason === 'aborted') return [];

    const files = [...this.files];
    this.files = new Set();
    return [
      ...this.progress(),
      this.event({ type: 'step.streamed' }),
      this.event({
        type: 'step.ended',
        finish: finishOf(message.stopReason),
        usage: usageOf(message),
        ...(files.length > 0 ? { files } : {}),
      }),
    ];
  }

  private toolEnd(frame: PiFrame): HarnessEvent {
    const tool = ToolEndSchema.safeParse(frame).data;
    const id = tool?.toolCallId;
    const name = tool?.toolName ?? (id ? this.toolNames.get(id) : undefined);
    const written = id ? this.writing.get(id) : undefined;
    if (id) this.writing.delete(id);
    if (written && !tool?.isError) this.files.add(written);
    const output = (tool?.result?.content ?? []).flatMap((part) => (part.text ? [part.text] : [])).join('\n');
    // pi gives no exit code: a bash command that exited non-zero ends its output with a line saying so.
    const exit = name === 'bash' ? output.match(EXIT_LINE)?.[1] : undefined;
    return this.event({
      type: 'tool.finished',
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      status: exit !== undefined || !tool?.isError ? 'success' : 'error',
      ...(exit !== undefined ? { exit: Number(exit) } : {}),
      ...(output ? { output } : {}),
    });
  }

  /** The retried attempt did something: stop keeping it out of the events. */
  private progress(): HarnessEvent[] {
    if (!this.retrying) return [];
    this.retrying = false;
    return this.takeDeferredStep();
  }

  private takeDeferredStep(): HarnessEvent[] {
    const step = this.deferredStep;
    this.deferredStep = undefined;
    return step ? [step] : [];
  }

  private takeFailure(): HarnessEvent[] {
    const failure = this.heldFailure;
    this.heldFailure = undefined;
    return failure ? [failure] : [];
  }

  private event<T extends HarnessEvent['type']>(fields: { type: T } & Omit<EventOf<T>, 'type' | 'created' | 'session'>): HarnessEvent {
    return { ...fields, created: this.now(), session: this.session } as unknown as HarnessEvent;
  }
}

/** opencode's names for how a call ended. */
function finishOf(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'toolUse':
      return 'tool-calls';
    case undefined:
      return 'stop';
    default:
      return stopReason;
  }
}

function usageOf(message: PiMessage): StepUsage {
  const usage = message.usage;
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    // pi counts thinking tokens in `output`.
    reasoning: 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: usage?.cost?.total ?? 0,
  };
}
