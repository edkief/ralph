import { clearAsk, rejectAskAnswer, waitForAskAnswer, writeAsk, type PermissionDecisionReply } from '../human/asks.js';
import type { FormAnswer } from '../ui/form-check.js';
import type { FormField } from '../ui/types.js';
import type { PermissionRequest } from '../opencode/events.js';

/** A form the agent opened and waits on: the question tool's, or an MCP server's request for input. */
export interface FormRequest {
  id: string;
  sessionID: string;
  title: string;
  /** `question`, `mcp`, or whatever opencode names the asker. */
  source?: string;
  fields: FormField[];
}

/** A person's answer to a form, or their refusal, with what the agent is told. */
export type FormOutcome = { answer: FormAnswer } | { cancel: string };

/** Told to the agent when a person declines a form without saying why. */
export const FORM_DECLINED_MESSAGE =
  'The person declined to answer. Carry on with a sensible default and record the assumption.';

/**
 * How a turn puts what it waits on to a person: through files for the web
 * UI, or in a terminal. Each call resolves with the answer, or with nothing
 * once `signal` aborts (the turn ended, the ask timed out or was settled
 * elsewhere).
 */
export interface AskRelay {
  form(form: FormRequest, signal: AbortSignal): Promise<FormOutcome | undefined>;
  permission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecisionReply | undefined>;
  /** opencode turned the last answer down; `form` or `permission` is called again for another. */
  rejected(id: string, error: string): void;
  /** The ask is over, however it ended. */
  settled(id: string): void;
}

/**
 * Asks left in the Ralph folder for the web UI, which answers beside them.
 * `origin` and its id say which run or planning session asks, for the UI to
 * show it in the right place.
 */
export function fileAskRelay(args: {
  ralphRoot: string;
  origin: { run: string } | { plan: string };
  /** The task at work, read when an ask opens. */
  taskId?: () => string | null;
  /** How long an ask waits; 0 or absent for as long as it takes. Shown to the person. */
  askMs?: number;
  pollMs?: number;
}): AskRelay {
  const { ralphRoot } = args;
  const base = () => ({
    ...('run' in args.origin ? { origin: 'run' as const, runId: args.origin.run } : { origin: 'plan' as const, planId: args.origin.plan }),
    taskId: args.taskId?.() ?? null,
    createdAt: new Date().toISOString(),
    ...(args.askMs ? { expiresAt: new Date(Date.now() + args.askMs).toISOString() } : {}),
  });
  const opened = new Set<string>();
  const wait = (id: string, signal: AbortSignal) =>
    waitForAskAnswer({ ralphRoot, id, signal, ...(args.pollMs ? { pollMs: args.pollMs } : {}) });

  return {
    async form(form, signal) {
      if (!opened.has(form.id)) {
        opened.add(form.id);
        writeAsk(ralphRoot, {
          id: form.id,
          kind: 'form',
          sessionID: form.sessionID,
          form: { title: form.title, ...(form.source ? { source: form.source } : {}), fields: form.fields },
          ...base(),
        });
      }
      const answer = await wait(form.id, signal);
      if (!answer) return undefined;
      if (answer.answer) return { answer: answer.answer };
      return { cancel: answer.cancel?.trim() || FORM_DECLINED_MESSAGE };
    },
    async permission(request, signal) {
      if (!opened.has(request.id)) {
        opened.add(request.id);
        writeAsk(ralphRoot, {
          id: request.id,
          kind: 'permission',
          sessionID: request.sessionID,
          permission: {
            action: request.action,
            resources: request.resources,
            ...(request.message ? { message: request.message } : {}),
          },
          ...base(),
        });
      }
      return (await wait(request.id, signal))?.decision;
    },
    rejected(id, error) {
      rejectAskAnswer(ralphRoot, id, error);
    },
    settled(id) {
      opened.delete(id);
      clearAsk(ralphRoot, id);
    },
  };
}
