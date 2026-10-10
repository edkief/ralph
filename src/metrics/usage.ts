import type { HarnessEvent } from '../harness/events.js';
import { HistoryDecoder } from '../harness/history.js';
import { LineTailer } from '../ui/tail.js';

/** What one model did in a turn: its calls, their tokens, and the time it spent generating. */
export interface ModelUsage {
  /** Model calls that ended. */
  steps: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** What the harness reported the calls cost, from the provider's prices; 0 for most self-hosted models. */
  cost: number;
  /** Time the model spent generating: each call's start to the end of its stream, less the tools run within it. */
  inferenceMs: number;
}

/** A turn's usage by model, keyed `provider/model`; `unknown` where no call named its model. */
export type TurnUsage = Record<string, ModelUsage>;

export const UNKNOWN_MODEL = 'unknown';

export function emptyUsage(): ModelUsage {
  return { steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, inferenceMs: 0 };
}

/** Add `from` into `into`. */
export function addModelUsage(into: ModelUsage, from: ModelUsage): ModelUsage {
  into.steps += from.steps;
  into.input += from.input;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cost += from.cost;
  into.inferenceMs += from.inferenceMs;
  return into;
}

/** Every token the calls processed or produced, cached ones included. */
export function totalTokens(usage: ModelUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
}

interface OpenStep {
  model: string;
  startedAt?: number;
  /** When the model's stream ended, if it has. */
  streamedAt?: number;
  /** Tools running within the step, by call id, with when they started. */
  tools: Map<string, number>;
  toolMs: number;
}

/**
 * Totals a turn's usage by model from its event stream. Each session's model
 * calls (subagents' too) are followed from `step.started`, which names the
 * model, to `step.ended`, which carries the tokens.
 *
 * Inference time is when the model was generating: from the step's start to
 * the end of its stream, less the time tools ran within it. A step started
 * again (a provider retry) starts over, as the wait before it is no work.
 */
export class UsageMeter {
  private usage: TurnUsage = {};
  private readonly steps = new Map<string, OpenStep>();
  /** The model each session last ran, for a step whose start was not seen. */
  private readonly models = new Map<string, string>();

  /** `now` stands in for an event without a `created` time. */
  push(event: HarnessEvent, now?: number): void {
    const session = event.session;
    if (!session) return;
    const at = event.created ?? now;

    switch (event.type) {
      case 'step.started': {
        const model = event.model ?? this.models.get(session) ?? UNKNOWN_MODEL;
        this.models.set(session, model);
        this.steps.set(session, { model, ...(at !== undefined ? { startedAt: at } : {}), tools: new Map(), toolMs: 0 });
        return;
      }
      case 'tool.called': {
        const step = this.steps.get(session);
        const id = event.id;
        if (step && id && at !== undefined && step.streamedAt === undefined) step.tools.set(id, at);
        return;
      }
      case 'tool.finished': {
        const step = this.steps.get(session);
        const id = event.id;
        const started = id ? step?.tools.get(id) : undefined;
        if (step && id && started !== undefined && at !== undefined) {
          step.toolMs += Math.max(0, at - started);
          step.tools.delete(id);
        }
        return;
      }
      case 'step.streamed': {
        const step = this.steps.get(session);
        if (step && step.streamedAt === undefined && at !== undefined) step.streamedAt = at;
        return;
      }
      case 'step.ended':
      case 'step.failed': {
        const step = this.steps.get(session);
        this.steps.delete(session);
        const model = step?.model ?? this.models.get(session) ?? UNKNOWN_MODEL;
        const usage = (this.usage[model] ??= emptyUsage());
        if (step?.startedAt !== undefined) {
          const end = step.streamedAt ?? at;
          if (end !== undefined) usage.inferenceMs += Math.max(0, end - step.startedAt - step.toolMs);
        }
        if (event.type === 'step.failed') return;
        usage.steps += 1;
        usage.input += event.usage.input;
        usage.output += event.usage.output;
        usage.reasoning += event.usage.reasoning;
        usage.cacheRead += event.usage.cacheRead;
        usage.cacheWrite += event.usage.cacheWrite;
        usage.cost += event.usage.cost;
        return;
      }
      default:
        return;
    }
  }

  /** The usage so far, and start over for the next turn. Steps still open are dropped. */
  drain(): TurnUsage {
    const usage = this.usage;
    this.reset();
    return usage;
  }

  reset(): void {
    this.usage = {};
    this.steps.clear();
    this.models.clear();
  }
}

/** The usage recorded in an event file, read a stretch at a time. */
export function usageOfEventsFile(path: string): TurnUsage {
  const meter = new UsageMeter();
  const decoder = new HistoryDecoder();
  const tailer = new LineTailer(path);
  for (let read = tailer.read(); ; read = tailer.read()) {
    for (const event of decoder.decode(read.lines)) meter.push(event);
    if (!read.more) break;
  }
  return meter.drain();
}
