import { Fragment } from 'react';
import { useJson, useNow, type EscalationView, type RunDetail, type SplitView, type StatusView } from '../api';
import { formatCount, formatDateTime, formatDuration, formatRunId, runBadge, statusLabel, statusTone } from '../format';
import { href } from '../route';
import { TaskRow, activeTaskId } from './TaskRow';
import { Pending, RunButtons, StopButtons } from './Pending';

/** Tasks listed before the one in progress: those just finished, as a rule. */
const DONE_BEFORE = 3;
/** Tasks listed from the one in progress on; the Tasks tab has them all. */
const UP_NEXT = 5;

export function Overview({ status }: { status: StatusView }) {
  const { tasks, run } = status;
  const now = useNow();
  // Refetch the run's iterations whenever the loop records a step.
  const detail = useJson<RunDetail>(run ? `/api/runs/${encodeURIComponent(run.runId)}` : null, run ? `${run.updatedAt}:${run.iteration}` : null);
  const iterations = detail.data?.iterations ?? [];
  const splits = detail.data?.splits ?? [];
  const escalations = detail.data?.escalations ?? [];
  const waiting = run?.live === true && run.status === 'waiting';
  const splitting = run?.live && !waiting ? run.split : null;
  const escalating = run?.live && !waiting ? escalations.find((turn) => turn.status === 'running') : undefined;
  const active = activeTaskId(status);
  const remaining = tasks.items.filter((task) => !task.passes);
  // A stretch of the Tasks tab's order around the task in progress: what came
  // just before it, then what comes next. With the backlog complete, its end.
  const at = [active, tasks.next].map((id) => tasks.items.findIndex((task) => task.id === id)).find((index) => index >= 0) ?? tasks.items.length;
  const upNext = tasks.items.slice(Math.max(0, at - DONE_BEFORE), at + UP_NEXT);
  const hidden = remaining.filter((task) => !upNext.includes(task)).length;
  const totalTokens = iterations.reduce((sum, iteration) => sum + (iteration.tokens ?? 0), 0);
  const badge = run ? runBadge(run) : null;
  /** Rows for these split turns, newest first. */
  const splitRows = (turns: SplitView[]) =>
    [...turns]
      .reverse()
      .map((split) => <SplitRow key={`${split.taskId}-${split.status}-${split.endedAt ?? ''}`} runId={run!.runId} split={split} now={now} />);
  /** Rows for the split and escalation turns that came after an iteration, newest first. */
  const afterRows = (splitTurns: SplitView[], escalationTurns: EscalationView[]) =>
    [
      ...splitTurns.map((split) => ({ startedAt: split.startedAt ?? '', row: splitRows([split]) })),
      ...escalationTurns.map((turn) => ({
        startedAt: turn.startedAt ?? '',
        row: <EscalationRow key={`escalation-${turn.n}`} runId={run!.runId} turn={turn} now={now} />,
      })),
    ]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
      .map((entry) => entry.row);

  return (
    <div className="stack">
      <Pending status={status} />
      {status.planState !== 'written' ? <Unplanned status={status} /> : null}
      <section className="cards">
        <div className="card">
          <div className="card-label">
            <a href={href('tasks')}>Tasks passing</a>
          </div>
          <div className="card-value">
            {tasks.passed}
            <span className="muted"> / {tasks.total}</span>
          </div>
          <div className="card-detail">{tasks.next ? <>Next: <span className="task-chip">{tasks.next}</span></> : tasks.total > 0 ? 'Backlog complete' : 'No tasks'}</div>
        </div>
        <div className="card">
          <div className="card-label">Run</div>
          <div className="card-value">
            {run ? (
              <span className={`badge large tone-${badge!.tone}`}>
                {badge!.pulse ? <span className="pulse" /> : null}
                {badge!.label}
              </span>
            ) : (
              <span className="muted">none</span>
            )}
          </div>
          <div className="card-detail">{run ? `Started ${formatDateTime(run.startedAt) !== '–' ? formatDateTime(run.startedAt) : formatRunId(run.runId)}` : status.daemon?.live ? (status.daemon.status === 'planning' ? 'The daemon is planning' : 'Run a batch below') : 'Start one with `ralph`'}</div>
          <DaemonLine status={status} />
          <StopButtons status={status} />
          <RunButtons key={run?.runId ?? 'none'} status={status} />
        </div>
        <div className="card">
          <div className="card-label">{run?.live ? 'Current iteration' : 'Iterations'}</div>
          <div className="card-value">
            {run?.iteration || 0}
            {run?.maxIterations ? <span className="muted"> / {run.maxIterations}</span> : null}
          </div>
          <div className="card-detail">
            {escalating
              ? `Escalating ${escalating.kind}${escalating.taskId ? ` on ${escalating.taskId}` : ''} · ${formatDuration(now - Date.parse(escalating.startedAt ?? ''))} so far`
              : splitting
              ? `${splitting.phase === 'assess' ? 'Assessing' : 'Splitting'} ${splitting.taskId} · ${formatDuration(now - Date.parse(splitting.startedAt))} so far`
              : waiting
              ? `${run?.taskId ?? ''} · waiting for you`
              : run?.live && run.iterationStartedAt
              ? `${run.taskId ?? ''} · ${formatDuration(now - Date.parse(run.iterationStartedAt))} so far`
              : run?.lastStatus
                ? `Last: ${statusLabel(run.lastStatus)}`
                : '–'}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Tokens this run</div>
          <div className="card-value">{formatCount(totalTokens)}</div>
          <div className="card-detail">{iterations.reduce((sum, iteration) => sum + (iteration.toolCalls ?? 0), 0)} tool calls</div>
        </div>
      </section>

      {tasks.error && status.planState === 'written' ? <div className="banner bad">{tasks.error}</div> : null}
      {run?.message && !run.live && !status.pending ? (
        <div className={`banner ${badge!.tone === 'bad' ? 'bad' : badge!.tone === 'good' ? 'good' : 'warn'}`}>
          {run.message}
        </div>
      ) : null}

      <section className="panel">
        <h2 className="panel-title">
          Iterations
          {run ? <span className="panel-subtitle">run {formatRunId(run.runId)}</span> : null}
        </h2>
        {iterations.length === 0 && splits.length === 0 && escalations.length === 0 ? (
          <div className="empty small">{run ? 'No iterations yet' : 'No runs yet'}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Task</th>
                  <th>Outcome</th>
                  <th className="num">Time</th>
                  <th className="num">Tools</th>
                  <th className="num">Tokens</th>
                  <th>Changes</th>
                </tr>
              </thead>
              <tbody>
                {/* Turns before an iteration that has not started, or never did. */}
                {afterRows(
                  splits.filter((split) => !iterations.some((iteration) => iteration.iteration === split.iteration)),
                  escalations.filter((turn) => !iterations.some((iteration) => iteration.iteration === turn.iteration)),
                )}
                {[...iterations].reverse().map((iteration) => (
                  <Fragment key={iteration.iteration}>
                  {afterRows(
                    splits.filter((split) => split.iteration === iteration.iteration && !split.trigger),
                    escalations.filter((turn) => turn.iteration === iteration.iteration),
                  )}
                  <tr>
                    <td>
                      <a href={href('transcript', `${run!.runId}/${iteration.iteration}`)} title="Open the transcript">{iteration.iteration}</a>
                    </td>
                    <td>{iteration.taskId ?? '–'}</td>
                    <td>
                      <span className={`badge tone-${statusTone(iteration.status)}`} title={iteration.error}>
                        {iteration.status === 'running' ? <span className="pulse" /> : null}
                        {statusLabel(iteration.status)}
                      </span>
                    </td>
                    <td className="num">
                      {iteration.status === 'running' && iteration.startedAt
                        ? formatDuration(now - Date.parse(iteration.startedAt))
                        : formatDuration(iteration.durationMs)}
                    </td>
                    <td className="num">{iteration.toolCalls ?? '–'}</td>
                    <td className="num">{formatCount(iteration.tokens)}</td>
                    <td>
                      <div className="changes">
                      {iteration.committed ? <span className="pill">commit</span> : null}
                      {iteration.tasksPassedDelta > 0 ? <span className="pill good">+{iteration.tasksPassedDelta} task</span> : null}
                      {iteration.compactions > 0 ? <span className="pill">compacted ×{iteration.compactions}</span> : null}
                      {iteration.handoff ? <span className="pill warn">handoff</span> : null}
                      {iteration.confirm ? (
                        <span
                          className={`pill ${iteration.confirm.verdict === 'confirmed' ? 'good' : 'warn'}`}
                          title={`Marked passing, but ${iteration.confirm.doubt}${iteration.confirm.reason ? `; reopened: ${iteration.confirm.reason}` : ''}`}
                        >
                          {iteration.confirm.verdict}
                        </span>
                      ) : null}
                      </div>
                    </td>
                  </tr>
                  {splitRows(splits.filter((split) => split.iteration === iteration.iteration && split.trigger === 'assessment'))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">
          Up next
          <span className="panel-subtitle">
            {tasks.passed} of {tasks.total} tasks passing
          </span>
          <a className="panel-link" href={href('tasks')}>
            All tasks
          </a>
        </h2>
        {tasks.items.length === 0 ? (
          <div className="empty small">No tasks in tasks.json</div>
        ) : (
          <ul className="task-list">
            {upNext.map((task) => (
              <TaskRow key={task.id} task={task} active={task.id === active} />
            ))}
            {hidden > 0 ? (
              <li className="task more">
                <a href={href('tasks')}>
                  {hidden} more to do
                </a>
              </li>
            ) : remaining.length === 0 ? (
              <li className="task more muted">Backlog complete</li>
            ) : null}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * A split turn or what became of its proposal, listed newest first above the
 * iteration that stalled on the task; an assessment, below the iteration it
 * came before.
 */
function SplitRow({ runId, split, now }: { runId: string; split: SplitView; now: number }) {
  const assessed = split.trigger === 'assessment';
  const estimate = split.estimateMinutes !== undefined ? `≈ ${split.estimateMinutes} min` : '';
  const outcome = [
    estimate,
    split.children && split.children.length > 0 && split.status !== 'failed'
      ? `→ ${split.children.join(', ')}`
      : estimate && split.reason
        ? `· ${split.reason}`
        : (split.reason ?? ''),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <tr className="split-row">
      <td>
        <a href={href('transcript', `${runId}/split-${split.taskId}`)} title={`Open the ${assessed ? 'assessment' : 'split'}'s transcript`}>{assessed ? 'assess' : 'split'}</a>
      </td>
      <td>{split.taskId}</td>
      <td>
        <span className={`badge tone-${statusTone(split.status)}`}>
          {split.status === 'running' ? <span className="pulse" /> : null}
          {statusLabel(split.status)}
        </span>
      </td>
      <td className="num">
        {split.status === 'running' && split.startedAt ? formatDuration(now - Date.parse(split.startedAt)) : formatDuration(split.durationMs)}
      </td>
      <td className="num">–</td>
      <td className="num">–</td>
      <td className="split-outcome" title={split.reason}>
        {outcome}
      </td>
    </tr>
  );
}

/**
 * A turn of the escalation agent, listed with the split turns above the
 * iteration whose request it got: the answer it gave and its note, or what it
 * passed on to a person.
 */
function EscalationRow({ runId, turn, now }: { runId: string; turn: EscalationView; now: number }) {
  const outcome = [turn.action ? `${turn.action}:` : '', turn.reason ?? ''].filter(Boolean).join(' ');
  return (
    <tr className="split-row">
      <td>
        <a href={href('transcript', `${runId}/escalation-${turn.n}`)} title="Open the escalation's transcript">
          escalate
        </a>
      </td>
      <td>{turn.taskId ?? '–'}</td>
      <td>
        <span className={`badge tone-${statusTone(turn.status)}`} title={`A ${turn.kind} request`}>
          {turn.status === 'running' ? <span className="pulse" /> : null}
          {statusLabel(turn.status)}
        </span>
      </td>
      <td className="num">
        {turn.status === 'running' && turn.startedAt ? formatDuration(now - Date.parse(turn.startedAt)) : formatDuration(turn.durationMs)}
      </td>
      <td className="num">–</td>
      <td className="num">–</td>
      <td className="split-outcome" title={turn.reason}>
        {outcome}
      </td>
    </tr>
  );
}

/** Whether a daemon holds the loop here, and what it is doing between runs. */
function DaemonLine({ status }: { status: StatusView }) {
  const { daemon, run } = status;
  if (!daemon?.live) return null;
  const idle = daemon.status === 'idle' && !run?.live;
  const last = idle && daemon.lastBatch?.status === 'failed' ? daemon.lastBatch.message : null;
  return (
    <div className="card-detail daemon-line">
      <span className={`badge tone-${idle ? 'muted' : 'live'}`}>{idle ? 'Daemon idle' : `Daemon ${daemon.status}`}</span>{' '}
      <span className="muted">pid {daemon.pid}</span>
      {last ? <div className="stop-note bad">Last batch failed: {last}</div> : null}
    </div>
  );
}

/** A project with no plan yet: where to make one. */
function Unplanned({ status }: { status: StatusView }) {
  const plan = status.plan;
  // A question from the planner has its own banner, above every view.
  if (plan?.live && plan.status === 'asking' && plan.by === 'daemon') return null;
  return (
    <a className="banner warn needs-you" href={href('plan')}>
      <strong>{plan?.live ? 'The project is being planned.' : 'This project has no plan yet.'}</strong>{' '}
      {plan?.live
        ? 'Follow the interview in the Plan tab →'
        : status.daemon?.live
          ? 'Plan it with the agent in the Plan tab →'
          : (
            <>
              Plan it with <code>ralph init</code> in a terminal, or start <code>ralph daemon</code> and plan it in the Plan tab →
            </>
          )}
    </a>
  );
}
