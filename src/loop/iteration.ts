import type { OpencodeClient } from '../opencode/client.js';
import {
  EXECUTION_DONE_EVENTS,
  ExecutionEndedSchema,
  PermissionRequestSchema,
  RetryScheduledSchema,
  SessionCreatedSchema,
  StepEndedSchema,
  StepFailedSchema,
  TextEndedSchema,
  ToolCalledSchema,
  ToolInputStartedSchema,
  ToolResultSchema,
  errorMessage,
  isActivityEvent,
  readData,
  type OpencodeEvent,
  type PermissionRequest,
} from '../opencode/events.js';
import { decidePermission, type PermissionDecision } from './permissions.js';
import { isContextOverflow } from '../opencode/overflow.js';
import { Watchdog, describeTrip, type WatchdogTrip } from './watchdog.js';
import { parsePromiseTags, type IterationStatus, type PromiseTags } from './outcome.js';
import { sleep } from '../opencode/server.js';
import type { WrapUpTrigger } from '../prompt/wrapup.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

export interface IterationUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cost: number;
}

export interface IterationResult {
  sessionId: string;
  status: IterationStatus;
  text: string;
  tags: PromiseTags;
  usage: IterationUsage;
  toolCalls: number;
  filesTouched: string[];
  providerRetries: number;
  lastProviderError?: string;
  /** Times opencode summarised the conversation to fit the context window. */
  compactions: number;
  error?: string;
  /** Set when the iteration ran out of time and the agent was asked to hand off. */
  wrapUp?: WrapUpRecord;
  durationMs: number;
}

export interface WrapUpRecord {
  trigger: WrapUpTrigger;
  /** `steer` reached the agent at its next step; `interrupt` stopped it first. */
  delivery: 'steer' | 'interrupt';
  /** The wrap-up turn ran to its end within the wrap-up budget. */
  completed: boolean;
  durationMs: number;
}

/** How long to wait for an interrupted execution to report that it ended. */
const INTERRUPT_SETTLE_MS = 15_000;

export interface IterationHooks {
  onText?: (text: string) => void;
  onTool?: (tool: string, detail: string) => void;
  onRetry?: (attempt: number, message: string) => void;
  onEvent?: (event: OpencodeEvent) => void;
}

export type PermissionPolicy = (request: PermissionRequest) => PermissionDecision;

/**
 * Run one agent turn: open a session (or continue `sessionId`), send the
 * prompt, and consume the event stream until the execution finishes or a
 * watchdog trips.
 *
 * The stream is subscribed *before* the prompt is sent so no early event can
 * be missed in the gap.
 */
export async function runIteration(args: {
  client: OpencodeClient;
  config: Config;
  prompt: string;
  title: string;
  /** Continue this session instead of opening a new one, for multi-turn conversations. */
  sessionId?: string;
  /** Answers permission requests; defaults to the configured policy. */
  permissions?: PermissionPolicy;
  /**
   * When the iteration runs out of time or goes quiet, send this prompt into
   * the same session and give the agent `timeouts.wrapUpMs` to act on it,
   * instead of interrupting it outright.
   */
  wrapUp?: { prompt: (trigger: WrapUpTrigger) => string };
  logger: Logger;
  hooks?: IterationHooks;
  signal: AbortSignal;
}): Promise<IterationResult> {
  const { client, config, logger, hooks = {}, signal } = args;
  const policy = args.permissions ?? ((request) => decidePermission(request, config.permissions));
  const startedAt = Date.now();

  const watchdogOptions = {
    iterationMs: config.timeouts.iterationMs,
    inactivityMs: config.timeouts.inactivityMs,
    maxProviderRetries: config.retries.providerRetriesPerIteration,
    wrapUpMs: config.timeouts.wrapUpMs,
  };
  const watchdog = new Watchdog(watchdogOptions);

  const streamAbort = new AbortController();
  const onOuterAbort = () => streamAbort.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });

  const usage: IterationUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 };
  const texts: string[] = [];
  const filesTouched = new Set<string>();
  let toolCalls = 0;
  // opencode names a tool on `tool.input.started` but describes its input on
  // `tool.called`; correlate the two by call id so status lines read
  // "shell npm test" rather than a bare "tool".
  const toolNames = new Map<string, string>();
  let trip: WatchdogTrip | null = null;
  let executionError: string | undefined;
  // Why the last model call failed, e.g. a context overflow; the execution's
  // own end event does not always repeat it.
  let stepFailure: string | undefined;
  let lastProviderError: string | undefined;
  let compactions = 0;
  let sessionId = '';
  // Subagents run in child sessions. Their work keeps the iteration alive and
  // their permission requests need answers, but their text, tools and
  // completion are not the iteration's own.
  const subagentSessions = new Set<string>();
  const promptOptions = {
    ...(config.model ? { model: config.model } : {}),
    ...(config.agent ? { agent: config.agent } : {}),
  };

  // The wrap-up is sent once, from the timer; `sent` flips before the prompt
  // goes out so the event loop knows which execution end is the wrap-up's.
  const wrapUp = {
    state: null as (Omit<WrapUpRecord, 'durationMs'> & { startedAt: number; sent: boolean }) | null,
    onInterruptedEnd: null as (() => void) | null,
  };

  const startWrapUp = async (trigger: WrapUpTrigger) => {
    const state: NonNullable<typeof wrapUp.state> = {
      trigger,
      delivery: 'interrupt',
      completed: false,
      startedAt: Date.now(),
      sent: false,
    };
    wrapUp.state = state;
    // The time budget can steer a working agent; a quiet one is stuck in a
    // tool, which only an interrupt ends.
    if (trigger === 'iteration-timeout' && (await client.supportsSteering())) state.delivery = 'steer';
    // The iteration may have ended while this was waiting.
    if (streamAbort.signal.aborted) return;
    logger.warn('asking the agent to wrap up', { reason: trigger, delivery: state.delivery });
    if (state.delivery === 'interrupt') {
      const ended = new Promise<void>((resolve) => (wrapUp.onInterruptedEnd = resolve));
      await client.interrupt(sessionId);
      await Promise.race([ended, sleep(INTERRUPT_SETTLE_MS, streamAbort.signal)]);
      wrapUp.onInterruptedEnd = null;
      if (streamAbort.signal.aborted) return;
    }
    state.sent = true;
    await client.prompt(sessionId, args.wrapUp!.prompt(trigger), {
      ...promptOptions,
      ...(state.delivery === 'steer' ? { delivery: 'steer' as const } : {}),
    });
  };

  const timer = setInterval(() => {
    const tripped = watchdog.check();
    if (!tripped) return;
    const canWrapUp =
      args.wrapUp && config.timeouts.wrapUpMs > 0 && sessionId && !watchdog.wrappingUp &&
      (tripped === 'iteration-timeout' || tripped === 'inactivity');
    if (canWrapUp) {
      watchdog.beginWrapUp();
      startWrapUp(tripped).catch((cause: unknown) => {
        logger.warn('wrap-up request failed', { error: (cause as Error).message });
        trip = tripped;
        streamAbort.abort();
      });
      return;
    }
    trip = tripped;
    streamAbort.abort();
  }, 1_000);

  try {
    // Subscribe before prompting so no early event is missed.
    const stream = await client.connectEvents(streamAbort.signal);
    sessionId = args.sessionId ?? (await client.createSession(args.title));
    await client.prompt(sessionId, args.prompt, promptOptions);
    logger.debug('prompt sent', { sessionId });

    for await (const event of stream) {
      if (event.type === 'session.created') {
        // Recorded whatever the session, so history shows every session the
        // server started during the turn — subagents included.
        hooks.onEvent?.(event);
        const created = readData(event, SessionCreatedSchema);
        if (created && created.sessionID !== sessionId) {
          const parent = created.parentID ?? (await lookupParent(client, created.sessionID, logger));
          if (parent && (parent === sessionId || subagentSessions.has(parent))) {
            subagentSessions.add(created.sessionID);
            logger.debug('subagent session started', { sessionId: created.sessionID });
          }
        }
        continue;
      }

      const eventSession = sessionIdOf(event);
      const fromSubagent = eventSession !== undefined && subagentSessions.has(eventSession);
      if (eventSession && eventSession !== sessionId && !fromSubagent) continue;
      hooks.onEvent?.(event);

      if (isActivityEvent(event.type)) watchdog.recordActivity();

      if (event.type.includes('permission')) {
        await handlePermission(event, client, policy, logger);
        watchdog.recordActivity();
        continue;
      }

      if (fromSubagent && event.type !== 'session.retry.scheduled') continue;

      switch (event.type) {
        case 'session.text.ended': {
          const data = readData(event, TextEndedSchema);
          if (data?.text) {
            texts.push(data.text);
            hooks.onText?.(data.text);
          }
          break;
        }
        case 'session.tool.input.started': {
          const data = readData(event, ToolInputStartedSchema);
          if (data?.id && data.name) toolNames.set(data.id, data.name);
          break;
        }
        case 'session.tool.called': {
          const data = readData(event, ToolCalledSchema);
          toolCalls += 1;
          const name = (data?.id ? toolNames.get(data.id) : undefined) ?? toolName(event);
          hooks.onTool?.(name, describeInput(data?.input));
          break;
        }
        case 'session.tool.error': {
          const data = readData(event, ToolResultSchema);
          logger.debug('tool error', { detail: firstText(data?.content) });
          break;
        }
        case 'session.step.ended': {
          const data = readData(event, StepEndedSchema);
          addUsage(usage, data);
          for (const file of data?.files ?? []) filesTouched.add(file);
          break;
        }
        case 'session.step.failed': {
          stepFailure = errorMessage(readData(event, StepFailedSchema)?.error) ?? stepFailure;
          logger.warn('model call failed', { error: stepFailure ?? 'unknown' });
          break;
        }
        case 'session.compaction.started':
          logger.info('compacting the conversation to fit the context window');
          break;
        case 'session.compaction.ended':
          compactions += 1;
          logger.info('conversation compacted', { compactions });
          break;
        case 'session.retry.scheduled': {
          const data = readData(event, RetryScheduledSchema);
          watchdog.recordProviderRetry();
          lastProviderError = data?.error?.message ?? data?.error?.type ?? 'unknown provider error';
          hooks.onRetry?.(data?.attempt ?? watchdog.providerRetries, lastProviderError);
          logger.warn('provider retry scheduled', {
            attempt: data?.attempt ?? watchdog.providerRetries,
            error: lastProviderError,
          });
          break;
        }
        default:
          break;
      }

      if (EXECUTION_DONE_EVENTS.has(event.type)) {
        // The end of the execution interrupted to make way for the wrap-up.
        if (wrapUp.state && !wrapUp.state.sent) {
          wrapUp.onInterruptedEnd?.();
          continue;
        }
        if (event.type === 'session.execution.failed') {
          const ended = readData(event, ExecutionEndedSchema);
          executionError = errorMessage(ended?.error) ?? stepFailure ?? 'execution failed';
        } else if (event.type !== 'session.execution.succeeded') {
          executionError = `execution ${event.type.split('.').pop()}`;
        }
        if (wrapUp.state) wrapUp.state.completed = !executionError;
        break;
      }
    }
  } catch (cause) {
    if (!isAbortError(cause)) throw cause;
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', onOuterAbort);
    streamAbort.abort();
    if (trip && sessionId) {
      await client.interrupt(sessionId).catch((cause: unknown) => {
        // The session may still be running and competing with the retry.
        logger.warn('interrupt failed', { sessionId, error: (cause as Error).message });
      });
    }
  }

  const text = texts.join('\n');
  const tags = parsePromiseTags(text);
  const wrapped = wrapUp.state;
  const reasons = [wrapped?.trigger, trip].flatMap((reason) =>
    reason ? [describeTrip(reason, watchdogOptions)] : [],
  );

  return {
    sessionId,
    status: classify({ trip, signal, executionError, tags, wrapUp: wrapped }),
    text,
    tags,
    usage,
    toolCalls,
    filesTouched: [...filesTouched],
    providerRetries: watchdog.providerRetries,
    ...(lastProviderError ? { lastProviderError } : {}),
    compactions,
    ...(reasons.length > 0 ? { error: reasons.join('; ') } : {}),
    ...(executionError && reasons.length === 0 ? { error: executionError } : {}),
    ...(wrapped
      ? {
          wrapUp: {
            trigger: wrapped.trigger,
            delivery: wrapped.delivery,
            completed: wrapped.completed && !trip,
            durationMs: Date.now() - wrapped.startedAt,
          },
        }
      : {}),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Map what happened to a status. Progress-vs-no-progress is decided by the
 * orchestrator, which can compare the repository before and after.
 */
function classify(args: {
  trip: WatchdogTrip | null;
  signal: AbortSignal;
  executionError: string | undefined;
  tags: PromiseTags;
  wrapUp: { completed: boolean } | null;
}): IterationStatus {
  if (args.signal.aborted) return 'interrupted';
  if (args.trip === 'retry-storm') return 'provider-error';
  if (args.trip) return 'timeout';
  if (args.tags.blockedReason) return 'blocked';
  if (args.tags.decideQuestion) return 'decide';
  // Out of time: whatever else the agent claimed, the task was cut short.
  if (args.wrapUp) return args.wrapUp.completed ? 'wrapped-up' : 'timeout';
  if (args.tags.complete) return 'complete';
  if (args.executionError) return isContextOverflow(args.executionError) ? 'context-overflow' : 'failed';
  return 'progressed';
}

/**
 * The event payload is not documented to carry `parentID`, but the session
 * record is, so fall back to fetching it. A failed lookup just means the
 * session is not treated as ours.
 */
async function lookupParent(
  client: OpencodeClient,
  sessionID: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    return (await client.getSession(sessionID)).parentID;
  } catch (cause) {
    logger.debug('session lookup failed', { sessionId: sessionID, error: (cause as Error).message });
    return undefined;
  }
}

async function handlePermission(
  event: OpencodeEvent,
  client: OpencodeClient,
  policy: PermissionPolicy,
  logger: Logger,
): Promise<void> {
  const request = readData(event, PermissionRequestSchema);
  if (!request) return;

  const decision = policy(request);
  logger.info('permission decided', {
    action: request.action,
    reply: decision.reply,
    reason: decision.reason,
    ...(decision.matched ? { matched: decision.matched } : {}),
  });

  await client.replyPermission(request.sessionID, request.id, decision.reply).catch((cause) => {
    logger.warn('permission reply failed', { error: (cause as Error).message });
  });
}

function addUsage(
  usage: IterationUsage,
  data: { tokens?: unknown; cost?: number | undefined } | undefined,
) {
  if (!data) return;
  const tokens = data.tokens as
    | { input?: number; output?: number; reasoning?: number; cache?: { read?: number } }
    | undefined;
  usage.input += tokens?.input ?? 0;
  usage.output += tokens?.output ?? 0;
  usage.reasoning += tokens?.reasoning ?? 0;
  usage.cacheRead += tokens?.cache?.read ?? 0;
  usage.cost += data.cost ?? 0;
}

function sessionIdOf(event: OpencodeEvent): string | undefined {
  const data = event.data as { sessionID?: unknown } | undefined;
  return typeof data?.sessionID === 'string' ? data.sessionID : undefined;
}

function toolName(event: OpencodeEvent): string {
  const data = event.data as { tool?: unknown; name?: unknown } | undefined;
  if (typeof data?.tool === 'string') return data.tool;
  if (typeof data?.name === 'string') return data.name;
  return 'tool';
}

function describeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const interesting = input['command'] ?? input['filePath'] ?? input['file_path'] ?? input['pattern'];
  return typeof interesting === 'string' ? interesting : '';
}

function firstText(content: Array<{ text?: string | undefined }> | undefined): string {
  return content?.find((entry) => entry.text)?.text ?? '';
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}
