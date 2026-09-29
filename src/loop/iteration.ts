import type { OpencodeClient } from '../opencode/client.js';
import {
  EXECUTION_DONE_EVENTS,
  PROGRESS_EVENTS,
  PermissionRequestSchema,
  RetryScheduledSchema,
  StepEndedSchema,
  TextEndedSchema,
  ToolCalledSchema,
  ToolInputStartedSchema,
  ToolResultSchema,
  readData,
  type OpencodeEvent,
} from '../opencode/events.js';
import { decidePermission } from './permissions.js';
import { Watchdog, describeTrip, type WatchdogTrip } from './watchdog.js';
import { parsePromiseTags, type IterationStatus, type PromiseTags } from './outcome.js';
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
  error?: string;
  durationMs: number;
}

export interface IterationHooks {
  onText?: (text: string) => void;
  onTool?: (tool: string, detail: string) => void;
  onRetry?: (attempt: number, message: string) => void;
  onEvent?: (event: OpencodeEvent) => void;
}

/**
 * Run one agent turn: open a session, send the prompt, and consume the event
 * stream until the execution finishes or a watchdog trips.
 *
 * The stream is subscribed *before* the prompt is sent so no early event can
 * be missed in the gap.
 */
export async function runIteration(args: {
  client: OpencodeClient;
  config: Config;
  prompt: string;
  title: string;
  logger: Logger;
  hooks?: IterationHooks;
  signal: AbortSignal;
}): Promise<IterationResult> {
  const { client, config, logger, hooks = {}, signal } = args;
  const startedAt = Date.now();

  const watchdogOptions = {
    iterationMs: config.timeouts.iterationMs,
    inactivityMs: config.timeouts.inactivityMs,
    maxProviderRetries: config.retries.providerRetriesPerIteration,
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
  let lastProviderError: string | undefined;
  let sessionId = '';

  const timer = setInterval(() => {
    const tripped = watchdog.check();
    if (tripped) {
      trip = tripped;
      streamAbort.abort();
    }
  }, 1_000);

  try {
    // Subscribe before prompting so no early event is missed.
    const stream = await client.connectEvents(streamAbort.signal);
    sessionId = await client.createSession(args.title);
    await client.prompt(sessionId, args.prompt, {
      ...(config.model ? { model: config.model } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
    });
    logger.debug('prompt sent', { sessionId });

    for await (const event of stream) {
      const eventSession = sessionIdOf(event);
      if (eventSession && eventSession !== sessionId) continue;
      hooks.onEvent?.(event);

      if (PROGRESS_EVENTS.has(event.type)) watchdog.recordActivity();

      if (event.type.includes('permission')) {
        await handlePermission(event, client, config, logger);
        watchdog.recordActivity();
        continue;
      }

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
        if (event.type !== 'session.execution.succeeded') {
          executionError = `execution ${event.type.split('.').pop()}`;
        }
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
        logger.debug('interrupt failed', { error: (cause as Error).message });
      });
    }
  }

  const text = texts.join('\n');
  const tags = parsePromiseTags(text);

  return {
    sessionId,
    status: classify({ trip, signal, executionError, tags }),
    text,
    tags,
    usage,
    toolCalls,
    filesTouched: [...filesTouched],
    providerRetries: watchdog.providerRetries,
    ...(lastProviderError ? { lastProviderError } : {}),
    ...(trip ? { error: describeTrip(trip, watchdogOptions) } : {}),
    ...(executionError && !trip ? { error: executionError } : {}),
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
}): IterationStatus {
  if (args.signal.aborted) return 'interrupted';
  if (args.trip === 'retry-storm') return 'provider-error';
  if (args.trip) return 'timeout';
  if (args.tags.blockedReason) return 'blocked';
  if (args.tags.decideQuestion) return 'decide';
  if (args.tags.complete) return 'complete';
  if (args.executionError) return 'failed';
  return 'progressed';
}

async function handlePermission(
  event: OpencodeEvent,
  client: OpencodeClient,
  config: Config,
  logger: Logger,
): Promise<void> {
  const request = readData(event, PermissionRequestSchema);
  if (!request) return;

  const decision = decidePermission(request, config.permissions);
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
