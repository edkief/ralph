import { Fragment } from 'react';
import { useJson, useNow, type RunDetail, type SplitView, type StatusView } from '../api';
import { formatCount, formatDateTime, formatDuration, formatRunId, statusLabel, statusTone } from '../format';
import { href } from '../route';

export function Overview({ status }: { status: StatusView }) {
  const { tasks, run } = status;
  const now = useNow();
  // Refetch the run's iterations whenever the loop records a step.
  const detail = useJson<RunDetail>(run ? `/api/runs/${encodeURIComponent(run.runId)}` : null, run ? `${run.updatedAt}:${run.iteration}` : null);
  const iterations = detail.data?.iterations ?? [];
  const splits = detail.data?.splits ?? [];
  const splitting = run?.live ? run.split : null;
  const totalTokens = iterations.reduce((sum, iteration) => sum + (iteration.tokens ?? 0), 0);
  const runStatus = run ? (run.status === 'running' && !run.live ? 'ended' : run.status) : null;

  return (
    <div className="stack">
      <section className="cards">
        <div className="card">
          <div className="card-label">Tasks passing</div>
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
              <span className={`badge large tone-${run.live ? 'live' : statusTone(runStatus)}`}>
                {run.live ? <span className="pulse" /> : null}
                {run.live ? 'Running' : statusLabel(runStatus)}
              </span>
            ) : (
              <span className="muted">none</span>
            )}
          </div>
          <div className="card-detail">{run ? `Started ${formatDateTime(run.startedAt) !== '–' ? formatDateTime(run.startedAt) : formatRunId(run.runId)}` : 'Start one with `ralph`'}</div>
        </div>
        <div className="card">
          <div className="card-label">{run?.live ? 'Current iteration' : 'Iterations'}</div>
          <div className="card-value">
            {run?.iteration || 0}
            {run?.maxIterations ? <span className="muted"> / {run.maxIterations}</span> : null}
          </div>
          <div className="card-detail">
            {splitting
              ? `Splitting ${splitting.taskId} · ${formatDuration(now - Date.parse(splitting.startedAt))} so far`
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

      {tasks.error ? <div className="banner bad">{tasks.error}</div> : null}
      {run?.message && !run.live ? (
        <div className={`banner ${statusTone(runStatus) === 'bad' ? 'bad' : statusTone(runStatus) === 'good' ? 'good' : 'warn'}`}>
          {run.message}
        </div>
      ) : null}

      <div className="split">
        <section className="panel">
          <h2 className="panel-title">Tasks</h2>
          {tasks.items.length === 0 ? (
            <div className="empty small">No tasks in tasks.json</div>
          ) : (
            <ul className="task-list">
              {tasks.items.map((task) => {
                const state = task.passes ? 'done' : task.id === (run?.live ? run.taskId : tasks.next) ? 'active' : 'todo';
                return (
                  <li key={task.id} className={`task ${state}`}>
                    <span className="task-state" aria-label={state === 'done' ? 'passing' : state === 'active' ? 'in progress' : 'to do'}>
                      {state === 'done' ? '✓' : state === 'active' ? '▶' : '○'}
                    </span>
                    <span className="task-id">{task.id}</span>
                    <span className="task-title">{task.title || <span className="muted">untitled</span>}</span>
                    {task.splitFrom ? (
                      <span className="task-split" title={`Split from ${task.splitFrom}, which kept running out of time`}>
                        from {task.splitFrom}
                      </span>
                    ) : null}
                    {task.category ? <span className="task-category">{task.category}</span> : null}
                    {task.specFilePath ? (
                      <a className="task-spec" href={href('files', task.specFilePath)} title="Open the spec">
                        spec
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">
            Iterations
            {run ? <span className="panel-subtitle">run {formatRunId(run.runId)}</span> : null}
          </h2>
          {iterations.length === 0 ? (
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
                  {[...iterations].reverse().map((iteration) => (
                    <Fragment key={iteration.iteration}>
                    {splits
                      .filter((split) => split.iteration === iteration.iteration)
                      .map((split) => (
                        <SplitRow key={split.taskId} runId={run!.runId} split={split} now={now} />
                      ))}
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
                        </div>
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** The turn that proposed splitting a task, listed after the iteration that stalled on it. */
function SplitRow({ runId, split, now }: { runId: string; split: SplitView; now: number }) {
  const outcome =
    split.children && split.children.length > 0 && split.status !== 'failed'
      ? `→ ${split.children.join(', ')}`
      : (split.reason ?? '');
  return (
    <tr className="split-row">
      <td>
        <a href={href('transcript', `${runId}/split-${split.taskId}`)} title="Open the split's transcript">split</a>
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
