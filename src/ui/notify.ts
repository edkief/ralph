import type { AskView, PendingView, PushEvent, PushPayload, RunDetail, StatusView } from './types.js';

/**
 * What has been notified already, so each event is sent once. Kept beside the
 * subscriptions, so a restarted server neither repeats nor replays anything.
 */
export interface Seen {
  /** The last request a person was told about. */
  pending: string | null;
  /** The last run whose end was told. */
  runEnded: string | null;
  /** The last iteration whose end was told. */
  iteration: { runId: string; n: number } | null;
  /** Tasks known to pass. */
  passed: string[];
  /** The last planner's question told, as `<session>:<seq>`; absent from stores written before planning was. */
  plan?: string | null | undefined;
  /** The forms and permissions waiting that were told; absent from stores written before asks were. */
  asks?: string[] | undefined;
}

export interface Notification {
  event: PushEvent;
  payload: PushPayload;
}

/**
 * The notifications that what the project shows now calls for, given what was
 * told before. With nothing told before, the watermark is taken from the
 * present and nothing is sent: a server that just started, or a first
 * subscriber, does not get the project's history.
 */
export function detect(
  seen: Seen | null,
  status: StatusView,
  detail: RunDetail | null,
): { seen: Seen; notifications: Notification[] } {
  const run = status.run;
  const pending = status.pending;
  const passed = status.tasks.error ? (seen?.passed ?? []) : status.tasks.items.filter((task) => task.passes).map((task) => task.id);
  const iteration = lastEnded(detail);
  const ended = run && !run.live ? run.runId : null;
  // Only a daemon's interview is answered from the UI; `ralph init` asks in its terminal.
  const plan = status.plan;
  const question = plan?.live && plan.status === 'asking' && plan.by === 'daemon' ? `${plan.id}:${plan.seq}` : null;

  const asks = status.asks.filter((ask) => !ask.answered);

  if (!seen) {
    return {
      seen: { pending: pending?.id ?? null, runEnded: ended, iteration, passed, plan: question, asks: asks.map((ask) => ask.id) },
      notifications: [],
    };
  }

  const project = status.project;
  const notifications: Notification[] = [];

  if (pending && !pending.answered && pending.id !== seen.pending) {
    notifications.push({
      event: 'request',
      payload: { title: `${project}: Ralph needs you`, body: requestBody(pending), tag: `request-${pending.id}`, path: '#/overview' },
    });
  }

  if (question && question !== seen.plan) {
    notifications.push({
      event: 'request',
      payload: {
        title: `${project}: Ralph needs you`,
        body: plan!.prompt && plan!.prompt !== 'you' ? truncate(`The planner asks: ${plan!.prompt}`, 200) : 'The planner has a question',
        tag: `plan-${plan!.id}`,
        path: '#/plan',
      },
    });
  }

  const toldAsks = new Set(seen.asks ?? []);
  for (const ask of asks) {
    if (toldAsks.has(ask.id)) continue;
    notifications.push({
      event: 'request',
      payload: {
        title: `${project}: Ralph needs you`,
        body: askBody(ask),
        tag: `ask-${ask.id}`,
        path: ask.origin === 'plan' ? '#/plan' : '#/overview',
      },
    });
  }

  // A run that ended over a request was told as the request.
  if (run && ended && ended !== seen.runEnded && pending?.runId !== ended) {
    const status = run.status === 'running' || run.status === 'waiting' ? 'ended' : run.status;
    const tasks = run.tasksTotal !== null ? ` · ${run.tasksPassed ?? 0}/${run.tasksTotal} tasks pass` : '';
    notifications.push({
      event: 'run-end',
      payload: {
        title: `${project}: the run ${status === 'complete' ? 'is complete' : `ended (${label(status)})`}`,
        body: `${run.message ? truncate(run.message, 160) : `After ${run.iteration} iteration${run.iteration === 1 ? '' : 's'}`}${tasks}`,
        tag: `run-${run.runId}`,
        path: '#/overview',
      },
    });
  }

  if (iteration && (seen.iteration?.runId !== iteration.runId || iteration.n > seen.iteration.n)) {
    const record = detail!.iterations.find((entry) => entry.iteration === iteration.n)!;
    notifications.push({
      event: 'iteration',
      payload: {
        title: `${project}: iteration ${iteration.n} ended`,
        body: [record.taskId, label(record.status), record.committed ? 'committed' : 'no commit'].filter(Boolean).join(' · '),
        tag: `iteration-${iteration.runId}-${iteration.n}`,
        path: `#/transcript/${encodeURIComponent(iteration.runId)}/${iteration.n}`,
      },
    });
  }

  const known = new Set(seen.passed);
  const newlyPassed = status.tasks.items.filter((task) => task.passes && !known.has(task.id));
  if (!status.tasks.error && newlyPassed.length > 0) {
    const first = newlyPassed[0]!;
    notifications.push({
      event: 'task',
      payload: {
        title:
          newlyPassed.length === 1 ? `${project}: ${first.id} passes` : `${project}: ${newlyPassed.length} tasks pass`,
        body: `${newlyPassed.map((task) => `${task.id} ${task.title}`).join(', ')} · ${status.tasks.passed}/${status.tasks.total} done`,
        tag: `task-${first.id}`,
        path: '#/tasks',
      },
    });
  }

  return {
    seen: {
      pending: pending?.id ?? seen.pending,
      runEnded: ended ?? seen.runEnded,
      iteration: iteration ?? seen.iteration,
      passed,
      plan: question ?? seen.plan ?? null,
      // Only those still waiting: an id is never asked twice.
      asks: asks.map((ask) => ask.id),
    },
    notifications,
  };
}

/** The latest iteration of the run with a record of how it ended. */
function lastEnded(detail: RunDetail | null): { runId: string; n: number } | null {
  const ended = detail?.iterations.filter((entry) => entry.status !== 'running') ?? [];
  const last = ended[ended.length - 1];
  return last ? { runId: detail!.run.runId, n: last.iteration } : null;
}

function requestBody(pending: PendingView): string {
  const what =
    pending.kind === 'split'
      ? `Review the proposed split of ${pending.taskId ?? 'the task'}`
      : pending.kind === 'decide'
        ? `A decision${pending.taskId ? ` on ${pending.taskId}` : ''}: ${pending.question ?? pending.message}`
        : pending.kind === 'blocked'
          ? `${pending.taskId ?? 'The agent'} is blocked: ${pending.message}`
          : pending.kind === 'budget'
            ? 'The iteration budget is spent'
            : `${pending.taskId ?? 'The run'} stalled: ${pending.message}`;
  return truncate(what, 200);
}

function askBody(ask: AskView): string {
  const on = ask.taskId ? ` on ${ask.taskId}` : ask.origin === 'plan' ? ' while planning' : '';
  if (ask.permission) {
    const what = [ask.permission.action, ...ask.permission.resources].join(' ');
    return truncate(`The agent asks permission${on}: ${what}`, 200);
  }
  const first = ask.form?.fields.find((field) => field.type !== 'external' && !field.hidden);
  const question = first?.title ?? first?.description ?? ask.form?.title ?? 'a question';
  const source = ask.form?.source === 'mcp' ? 'An MCP server asks' : 'The agent asks';
  return truncate(`${source}${on}: ${question}`, 200);
}

function label(status: string): string {
  return status.replace(/-/g, ' ');
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
