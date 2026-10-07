import { OpencodeApiError, type OpencodeClient } from '../opencode/client.js';
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
  TURN_STARTED_EVENT,
  errorMessage,
  isActivityEvent,
  readData,
  sessionIdOf,
  toolName,
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
  cacheWrite: number;
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
  /** The watchdog budget that ended the turn, if one did. */
  trip?: WatchdogTrip;
  /** Times the agent ended its turn early and was prompted to carry on in the same session. */
  resumes?: number;
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
  /** Once aborted, ask for the wrap-up at once: a person is parking the run. Needs `wrapUp`. */
  park?: AbortSignal;
  /** Working time for this turn, when it is less than a whole iteration's, e.g. a resumed turn. */
  iterationMs?: number;
  logger: Logger;
  hooks?: IterationHooks;
  signal: AbortSignal;
}): Promise<IterationResult> {
  const { client, config, logger, hooks = {}, signal } = args;
  const policy = args.permissions ?? ((request) => decidePermission(request, config.permissions));
  const startedAt = Date.now();

  const watchdogOptions = {
    iterationMs: args.iterationMs ?? config.timeouts.iterationMs,
    inactivityMs: config.timeouts.inactivityMs,
    maxProviderRetries: config.retries.providerRetriesPerIteration,
    wrapUpMs: config.timeouts.wrapUpMs,
  };
  const watchdog = new Watchdog(watchdogOptions);

  const streamAbort = new AbortController();
  const onOuterAbort = () => streamAbort.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });

  const usage: IterationUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
  // A permission request the server never got an answer to: the agent would
  // wait on it for good, so the turn ends here.
  let permissionFailure: string | undefined;
  let compactions = 0;
  let sessionId = '';
  // Whether opencode reported the turn's execution over. Until it does, the
  // agent is still at work on the server.
  let executionEnded = false;
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
    state: null as
      | (Omit<WrapUpRecord, 'durationMs'> & { startedAt: number; sent: boolean; textIndex: number })
      | null,
    onInterruptedEnd: null as (() => void) | null,
  };

  const startWrapUp = async (trigger: WrapUpTrigger) => {
    const state: NonNullable<typeof wrapUp.state> = {
      trigger,
      delivery: 'interrupt',
      completed: false,
      startedAt: Date.now(),
      sent: false,
      textIndex: Number.POSITIVE_INFINITY,
    };
    wrapUp.state = state;
    // The time budget and a park can steer a working agent; a quiet one is
    // stuck in a tool, which only an interrupt ends.
    if (trigger !== 'inactivity' && (await client.supportsSteering())) state.delivery = 'steer';
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
    state.textIndex = texts.length;
    await client.prompt(sessionId, args.wrapUp!.prompt(trigger), {
      ...promptOptions,
      ...(state.delivery === 'steer' ? { delivery: 'steer' as const } : {}),
    });
  };

  const timer = setInterval(() => {
    if (args.park?.aborted && args.wrapUp && config.timeouts.wrapUpMs > 0 && sessionId && !watchdog.wrappingUp) {
      watchdog.beginWrapUp();
      startWrapUp('park').catch((cause: unknown) => {
        logger.warn('wrap-up request failed', { error: (cause as Error).message });
        streamAbort.abort();
      });
      return;
    }
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
    // Recorded before any of the session's events, so its own work is never taken for a subagent's.
    hooks.onEvent?.({
      type: TURN_STARTED_EVENT,
      created: Date.now(),
      data: { sessionID: sessionId, continued: args.sessionId !== undefined },
    });
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
      // Compaction is quiet until it ends, whichever session it is for.
      if (event.type === 'session.compaction.started' || event.type === 'session.compaction.delta') {
        watchdog.beginCompaction();
      }

      if (event.type.includes('permission')) {
        permissionFailure = await handlePermission(event, client, policy, logger);
        if (permissionFailure) {
          executionError = permissionFailure;
          break;
        }
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
        executionEnded = true;
        break;
      }
    }
  } catch (cause) {
    // A stream cut off while stopping is the stop, e.g. a Ctrl-C that reached the server too.
    if (!isAbortError(cause) && !streamAbort.signal.aborted) throw cause;
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', onOuterAbort);
    streamAbort.abort();
    // However the turn ended early (a watchdog, a permission reply that never
    // landed, a stop, a broken stream), stop the agent too: closing the stream
    // does not, and a daemon's or an attached server outlives the turn.
    if (sessionId && !executionEnded) {
      await Promise.all([
        client.interrupt(sessionId).catch((cause: unknown) => {
          // The session may still be running and competing with the retry.
          logger.warn('interrupt failed', { sessionId, error: (cause as Error).message });
        }),
        ...[...subagentSessions].map((id) =>
          client.interrupt(id).catch((cause: unknown) => {
            // It may well have finished already.
            logger.debug('subagent interrupt failed', { sessionId: id, error: (cause as Error).message });
          }),
        ),
      ]);
    }
  }

  const text = texts.join('\n');
  const wrapped = wrapUp.state;
  const tags = promiseTags(texts, wrapped, logger);
  const reasons = [wrapped?.trigger, trip].flatMap((reason) =>
    reason === 'park' ? ['Parked on request'] : reason ? [describeTrip(reason, watchdogOptions)] : [],
  );

  return {
    sessionId,
    status: classify({ trip, signal, executionError, permissionFailure, tags, wrapUp: wrapped }),
    text,
    tags,
    usage,
    toolCalls,
    filesTouched: [...filesTouched],
    providerRetries: watchdog.providerRetries,
    ...(lastProviderError ? { lastProviderError } : {}),
    compactions,
    ...(trip ? { trip } : {}),
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
 * One result for two turns of the same iteration, the second resuming the
 * first in its session: what the agent did adds up, and how it ended is the
 * second turn's.
 */
export function joinTurns(first: IterationResult, second: IterationResult): IterationResult {
  const usage = { ...first.usage };
  for (const key of Object.keys(usage) as Array<keyof IterationUsage>) usage[key] += second.usage[key];
  return {
    ...second,
    sessionId: second.sessionId || first.sessionId,
    text: [first.text, second.text].filter(Boolean).join('\n'),
    usage,
    toolCalls: first.toolCalls + second.toolCalls,
    filesTouched: [...new Set([...first.filesTouched, ...second.filesTouched])],
    providerRetries: first.providerRetries + second.providerRetries,
    ...(second.lastProviderError ?? first.lastProviderError
      ? { lastProviderError: second.lastProviderError ?? first.lastProviderError }
      : {}),
    compactions: first.compactions + second.compactions,
    durationMs: first.durationMs + second.durationMs,
  };
}

/**
 * The promise tags that stand. Running out of time is not being blocked, so a
 * BLOCKED or DECIDE raised in answer to the wrap-up is dropped: the next
 * iteration resumes from the handoff. A BLOCKED after an inactivity wrap-up
 * stands, since a command that hung is often the environment problem it is for.
 */
function promiseTags(
  texts: string[],
  wrapped: { trigger: WrapUpTrigger; textIndex: number } | null,
  logger: Logger,
): PromiseTags {
  const tags = parsePromiseTags(texts.join('\n'));
  if (!wrapped || wrapped.textIndex >= texts.length) return tags;

  const before = parsePromiseTags(texts.slice(0, wrapped.textIndex).join('\n'));
  const blocked = before.blockedReason ?? (wrapped.trigger === 'inactivity' ? tags.blockedReason : undefined);
  const decide = before.decideQuestion;
  const { blockedReason: _blocked, decideQuestion: _decide, ...rest } = tags;
  if (tags.blockedReason !== blocked || tags.decideQuestion !== decide) {
    logger.warn('ignoring a promise tag raised in the wrap-up', {
      reason: wrapped.trigger,
      ...(tags.blockedReason !== blocked ? { blocked: tags.blockedReason } : {}),
      ...(tags.decideQuestion !== decide ? { decide: tags.decideQuestion } : {}),
    });
  }
  return { ...rest, ...(blocked ? { blockedReason: blocked } : {}), ...(decide ? { decideQuestion: decide } : {}) };
}

/**
 * Map what happened to a status. Progress-vs-no-progress is decided by the
 * orchestrator, which can compare the repository before and after.
 */
function classify(args: {
  trip: WatchdogTrip | null;
  signal: AbortSignal;
  executionError: string | undefined;
  permissionFailure: string | undefined;
  tags: PromiseTags;
  wrapUp: { completed: boolean } | null;
}): IterationStatus {
  if (args.signal.aborted) return 'interrupted';
  if (args.trip === 'retry-storm') return 'provider-error';
  if (args.trip) return 'timeout';
  // The turn was cut off mid-tool; nothing the agent said before then stands.
  if (args.permissionFailure) return 'failed';
  if (args.tags.blockedReason) return 'blocked';
  if (args.tags.decideQuestion) return 'decide';
  // Out of time: whatever else the agent claimed, the task was cut short.
  if (args.wrapUp) return args.wrapUp.completed ? 'wrapped-up' : 'timeout';
  if (args.tags.complete) return 'complete';
  if (args.executionError) return isContextOverflow(args.executionError) ? 'context-overflow' : 'failed';
  return 'progressed';
}

/** Tries at delivering a permission reply before the turn is given up on. */
const PERMISSION_REPLY_ATTEMPTS = 2;

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

/**
 * Answer a permission request from policy. Returns why the answer could not
 * be delivered, if it could not: the agent stays blocked on an unanswered
 * request, so the caller ends the turn rather than wait for the watchdog.
 */
async function handlePermission(
  event: OpencodeEvent,
  client: OpencodeClient,
  policy: PermissionPolicy,
  logger: Logger,
): Promise<string | undefined> {
  const request = readData(event, PermissionRequestSchema);
  if (!request) return undefined;

  const decision = policy(request);
  logger.info('permission decided', {
    action: request.action,
    reply: decision.reply,
    reason: decision.reason,
    ...(decision.matched ? { matched: decision.matched } : {}),
  });

  // A rejected request fails the same way twice; anything else may be a blip.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.replyPermission(request.sessionID, request.id, decision.reply);
      return undefined;
    } catch (cause) {
      const status = cause instanceof OpencodeApiError ? cause.status : undefined;
      // Already answered, by a person or an earlier attempt: nothing is waiting.
      if (status === 404) {
        logger.debug('permission request already gone', { id: request.id });
        return undefined;
      }
      const rejected = status !== undefined && status >= 400 && status < 500;
      logger.warn('permission reply failed', {
        error: (cause as Error).message,
        // The server says which field it rejected; without it a 400 is opaque.
        ...(cause instanceof OpencodeApiError && cause.body ? { body: cause.body } : {}),
      });
      if (rejected || attempt >= PERMISSION_REPLY_ATTEMPTS) {
        return describeReplyFailure(request.action, cause);
      }
    }
  }
}

function describeReplyFailure(action: string, cause: unknown): string {
  if (!(cause instanceof OpencodeApiError)) {
    return `Permission reply for ${action} could not be delivered: ${(cause as Error).message}`;
  }
  let detail = cause.body;
  try {
    detail = (JSON.parse(cause.body) as { message?: string }).message ?? cause.body;
  } catch {
    // Not JSON; the raw body is the best there is.
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `Permission reply for ${action} was rejected by the server (${cause.status})${detail ? `: ${detail}` : ''}`;
}

function addUsage(
  usage: IterationUsage,
  data: { tokens?: unknown; cost?: number | undefined } | undefined,
) {
  if (!data) return;
  const tokens = data.tokens as
    | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    | undefined;
  usage.input += tokens?.input ?? 0;
  usage.output += tokens?.output ?? 0;
  usage.reasoning += tokens?.reasoning ?? 0;
  usage.cacheRead += tokens?.cache?.read ?? 0;
  usage.cacheWrite += tokens?.cache?.write ?? 0;
  usage.cost += data.cost ?? 0;
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
