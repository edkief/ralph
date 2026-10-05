import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { useJson, type MetricsTask, type MetricsTurn, type MetricsUsage, type MetricsView, type StatusView } from '../api';
import { formatCount, formatDateTime, formatDuration, formatRunId, statusLabel, statusTone } from '../format';
import { href } from '../route';

const SECTIONS = [
  { id: '', label: 'Summary' },
  { id: 'days', label: 'By day' },
  { id: 'tasks', label: 'By task' },
  { id: 'runs', label: 'By run' },
] as const;

/** Days the summary's chart covers, up to the latest. */
const CHART_DAYS = 30;

type Measure = 'tokens' | 'inferenceMs' | 'estimatedCost';

/**
 * What the project's model work came to, over every run: totals, then by
 * model, by day, by task and by run. `selected` is the drilldown in the URL:
 * `days`, `tasks`, `tasks/<id>` or `runs`.
 */
export function Metrics({ status, selected }: { status: StatusView; selected: string }) {
  const run = status.run;
  // Refetch whenever the loop records a step.
  const metrics = useJson<MetricsView>('/api/metrics', run ? `${run.runId}:${run.updatedAt}:${run.iteration}` : null);
  const [section = '', taskId] = selected.split('/');
  const data = metrics.data;

  return (
    <div className="stack">
      <nav className="subtabs" aria-label="Metrics views">
        {SECTIONS.map((entry) => (
          <a
            key={entry.id}
            href={href('metrics', entry.id)}
            className={section === entry.id ? 'subtab active' : 'subtab'}
            aria-current={section === entry.id ? 'page' : undefined}
          >
            {entry.label}
          </a>
        ))}
      </nav>
      {metrics.error ? <div className="banner bad">{metrics.error}</div> : null}
      {!data ? (
        <div className="empty">{metrics.error ? '' : 'Loading…'}</div>
      ) : data.turns.length === 0 ? (
        <div className="empty">No finished turns yet: metrics appear once the first iteration is recorded.</div>
      ) : (
        <>
          <Coverage data={data} />
          {section === 'days' ? (
            <Days data={data} />
          ) : section === 'tasks' ? (
            taskId ? <TaskTurns data={data} taskId={taskId} /> : <Tasks data={data} />
          ) : section === 'runs' ? (
            <Runs data={data} />
          ) : (
            <Summary data={data} />
          )}
        </>
      )}
    </div>
  );
}

function Summary({ data }: { data: MetricsView }) {
  const { totals, cost } = data;
  return (
    <>
      <section className="cards">
        <div className="card">
          <div className="card-label">Iterations</div>
          <div className="card-value">{totals.iterations}</div>
          <div className="card-detail">
            {totals.planningTurns} planning turn{totals.planningTurns === 1 ? '' : 's'} · {totals.runs} run{totals.runs === 1 ? '' : 's'}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Inference time</div>
          <div className="card-value">{formatDuration(totals.inferenceMs)}</div>
          <div className="card-detail" title="Wall-clock time of the turns, tool runs included">
            of {formatDuration(totals.wallMs)} working · {formatCount(totals.steps)} model calls
          </div>
        </div>
        <div className="card">
          <div className="card-label">Tokens</div>
          <div className="card-value">{formatCount(totals.tokens)}</div>
          <div className="card-detail" title={tokenBreakdown(totals)}>
            {formatCount(totals.input)} in · {formatCount(totals.output)} out · {formatCount(totals.cacheRead + totals.cacheWrite)} cached
          </div>
        </div>
        <div className="card">
          <div className="card-label">Estimated cost</div>
          <div className="card-value">
            {totals.estimatedCost !== null ? formatMoney(totals.estimatedCost, cost.currency) : <span className="muted">not set</span>}
          </div>
          <div className="card-detail" title={cost.basis ?? undefined}>
            {cost.basis ?? (
              <>
                Set <code>metrics.cost</code> in ralph.config.json
              </>
            )}
            {totals.reportedCost > 0 ? ` · ${formatMoney(totals.reportedCost, 'USD')} reported by opencode` : ''}
          </div>
        </div>
      </section>

      <DailyChart data={data} />

      <section className="panel">
        <h2 className="panel-title">
          Models
          <span className="panel-subtitle">{data.models.length} used</span>
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Turns</th>
                <th className="num">Calls</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Reasoning</th>
                <th className="num">Cached</th>
                <th className="num">Share</th>
                <th className="num">Inference</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((model) => (
                <tr key={model.model}>
                  <td>{model.model === 'unknown' ? <span className="muted" title="Turns recorded before Ralph recorded the model">unknown</span> : <code>{model.model}</code>}</td>
                  <td className="num">{model.turns}</td>
                  <td className="num">{model.steps ? formatCount(model.steps) : '–'}</td>
                  <td className="num">{formatCount(model.input)}</td>
                  <td className="num">{formatCount(model.output)}</td>
                  <td className="num">{formatCount(model.reasoning)}</td>
                  <td className="num">{formatCount(model.cacheRead + model.cacheWrite)}</td>
                  <td className="num">{totals.tokens > 0 ? `${Math.round((model.tokens / totals.tokens) * 100)}%` : '–'}</td>
                  <td className="num">{formatDuration(model.inferenceMs)}</td>
                  <td className="num">{costCell(model, data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** Says how much of the figures rest on turns recorded before usage was. */
function Coverage({ data }: { data: MetricsView }) {
  const { legacy, none } = data.coverage;
  if (legacy === 0 && none === 0) return null;
  const parts = [
    legacy > 0
      ? `${legacy} turn${legacy === 1 ? '' : 's'} from before Ralph recorded usage, with no event file on this machine, count${legacy === 1 ? 's' : ''} under an unknown model with wall-clock time in place of inference time`
      : '',
    none > 0 ? `${none} planning turn${none === 1 ? '' : 's'} from then ha${none === 1 ? 's' : 've'} no usage at all` : '',
  ].filter(Boolean);
  return <div className="banner warn">Approximate: {parts.join('; ')}.</div>;
}

interface Day extends MetricsUsage {
  key: string;
  date: Date;
  iterations: number;
  planningTurns: number;
}

/** Turns grouped by the day they started on, in this browser's time zone, with every day between. */
function useDays(turns: MetricsTurn[], withCost: boolean): Day[] {
  return useMemo(() => {
    const days = new Map<string, Day>();
    for (const turn of turns) {
      if (!turn.startedAt) continue;
      const started = new Date(turn.startedAt);
      if (Number.isNaN(started.getTime())) continue;
      const date = new Date(started.getFullYear(), started.getMonth(), started.getDate());
      const key = dayKey(date);
      const day = days.get(key) ?? { ...zero(withCost), key, date, iterations: 0, planningTurns: 0 };
      add(day, turn);
      if (turn.kind === 'iteration') day.iterations += 1;
      else day.planningTurns += 1;
      days.set(key, day);
    }
    const known = [...days.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
    if (known.length === 0) return [];
    // Every day from the first to the last, so quiet days show as gaps.
    const all: Day[] = [];
    for (let date = known[0]!.date; date <= known.at(-1)!.date; date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)) {
      all.push(days.get(dayKey(date)) ?? { ...zero(withCost), key: dayKey(date), date, iterations: 0, planningTurns: 0 });
    }
    return all;
  }, [turns, withCost]);
}

const MEASURES: Array<{ id: Measure; label: string }> = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'inferenceMs', label: 'Inference time' },
  { id: 'estimatedCost', label: 'Estimated cost' },
];

function DailyChart({ data }: { data: MetricsView }) {
  const withCost = data.cost.estimator !== null;
  const days = useDays(data.turns, withCost).slice(-CHART_DAYS);
  const [measure, setMeasure] = useState<Measure>('tokens');
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = measure === 'estimatedCost' && !withCost ? 'tokens' : measure;
  const value = (day: Day) => (shown === 'estimatedCost' ? (day.estimatedCost ?? 0) : day[shown]);
  const format = (amount: number) =>
    shown === 'tokens' ? formatCount(amount) : shown === 'inferenceMs' ? formatDuration(amount) : formatMoney(amount, data.cost.currency);
  const max = niceMax(Math.max(0, ...days.map(value)), shown);

  // Drawn at the panel's own width, so text and bars keep their size.
  const [box, width] = useWidth(720);
  const height = 200;
  const left = 56;
  const bottom = 22;
  const top = 8;
  const plotWidth = width - left - 4;
  const plotHeight = height - top - bottom;
  const slot = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(28, slot - 2));
  const ticks = [0, 0.5, 1].map((fraction) => fraction * max);
  // A date label every so many days, so that labels some 56px wide never touch.
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotWidth / 56))));
  const day = hovered !== null ? days[hovered] : undefined;

  return (
    <section className="panel">
      <h2 className="panel-title">
        Per day
        <span className="panel-subtitle">{days.length < CHART_DAYS ? 'every day so far' : `last ${CHART_DAYS} days`}</span>
        <a className="panel-link" href={href('metrics', 'days')}>
          All days →
        </a>
      </h2>
      <div className="chart-toolbar" role="radiogroup" aria-label="Measure">
        {MEASURES.filter((entry) => entry.id !== 'estimatedCost' || withCost).map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={shown === entry.id}
            className={shown === entry.id ? 'button small selected' : 'button small'}
            onClick={() => setMeasure(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="chart" ref={box} onMouseLeave={() => setHovered(null)}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${MEASURES.find((entry) => entry.id === shown)!.label} per day`}>
          {ticks.map((tick) => {
            const y = top + plotHeight - (max > 0 ? (tick / max) * plotHeight : 0);
            return (
              <g key={tick}>
                <line className="chart-grid" x1={left} x2={width - 4} y1={y} y2={y} />
                <text className="chart-axis" x={left - 8} y={y} dy="0.32em" textAnchor="end">
                  {format(tick)}
                </text>
              </g>
            );
          })}
          {days.map((entry, index) => {
            const amount = value(entry);
            const barHeight = max > 0 ? (amount / max) * plotHeight : 0;
            const x = left + index * slot + (slot - barWidth) / 2;
            return (
              <g key={entry.key}>
                {amount > 0 ? (
                  <path
                    className={hovered === index ? 'chart-bar active' : 'chart-bar'}
                    d={roundedTop(x, top + plotHeight - barHeight, barWidth, barHeight, Math.min(4, barWidth / 2))}
                  />
                ) : null}
                {index % labelEvery === 0 ? (
                  <text className="chart-axis" x={x + barWidth / 2} y={height - 6} textAnchor="middle">
                    {entry.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </text>
                ) : null}
                {/* The hit target is the whole column, wider and taller than the bar. */}
                <rect
                  className="chart-hit"
                  x={left + index * slot}
                  y={top}
                  width={slot}
                  height={plotHeight}
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                  tabIndex={0}
                  aria-label={`${entry.date.toLocaleDateString()}: ${format(amount)}`}
                />
              </g>
            );
          })}
        </svg>
        {day ? (
          <div
            className="chart-tooltip"
            style={{ left: `${12 + Math.min(Math.max(left + (hovered! + 0.5) * slot, 70), width - 70)}px` }}
            role="status"
          >
            <strong>{day.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
            <div>{formatCount(day.tokens)} tokens</div>
            <div>{formatDuration(day.inferenceMs)} inference</div>
            {day.estimatedCost !== null ? <div>{formatMoney(day.estimatedCost, data.cost.currency)}</div> : null}
            <div className="muted">
              {day.iterations} iteration{day.iterations === 1 ? '' : 's'}
              {day.planningTurns ? ` · ${day.planningTurns} planning` : ''}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Days({ data }: { data: MetricsView }) {
  const withCost = data.cost.estimator !== null;
  const days = useDays(data.turns, withCost).filter((day) => day.iterations + day.planningTurns > 0);
  return (
    <>
      <DailyChart data={data} />
      <section className="panel">
        <h2 className="panel-title">
          By day
          <span className="panel-subtitle">in this browser's time zone</span>
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Iterations</th>
                <th className="num">Planning</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cached</th>
                <th className="num">Tokens</th>
                <th className="num">Inference</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((day) => (
                <tr key={day.key}>
                  <td>{day.date.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  <td className="num">{day.iterations}</td>
                  <td className="num">{day.planningTurns}</td>
                  <td className="num">{formatCount(day.input)}</td>
                  <td className="num">{formatCount(day.output)}</td>
                  <td className="num">{formatCount(day.cacheRead + day.cacheWrite)}</td>
                  <td className="num">{formatCount(day.tokens)}</td>
                  <td className="num">{formatDuration(day.inferenceMs)}</td>
                  <td className="num">{costCell(day, data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Tasks({ data }: { data: MetricsView }) {
  const byId = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const roots = data.tasks.filter((task) => !task.parent || !byId.has(task.parent));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = (task: MetricsTask, depth: number, path: Set<string>): ReactElement => {
    const open = !collapsed.has(task.id);
    const split = task.children.length > 0;
    const { total } = task;
    return (
      <Fragment key={task.id}>
        <tr className={split ? 'metrics-split' : undefined}>
          <td>
            <span className="metrics-task" style={{ paddingLeft: `${depth * 18}px` }}>
              {split ? (
                <button type="button" className="disclosure" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the tasks ${task.id} was split into`} onClick={() => toggle(task.id)}>
                  {open ? '▾' : '▸'}
                </button>
              ) : (
                <span className="disclosure-space" />
              )}
              <a href={href('metrics', `tasks/${task.id}`)} className="task-chip">
                {task.id}
              </a>
              <span className="metrics-title">{task.title ?? (split ? 'split' : '')}</span>
            </span>
          </td>
          <td>
            {task.passes === null ? (
              <span className="pill">{split ? `split into ${task.children.length}` : 'gone'}</span>
            ) : (
              <span className={`badge tone-${task.passes ? 'good' : 'muted'}`}>{task.passes ? 'passes' : 'open'}</span>
            )}
          </td>
          <td className="num">{total.iterations}</td>
          <td className="num">{total.planningTurns}</td>
          <td className="num" title={split ? `${formatCount(task.tokens)} on ${task.id} itself` : undefined}>
            {formatCount(total.tokens)}
          </td>
          <td className="num">{formatDuration(total.inferenceMs)}</td>
          <td className="num">{costCell(total, data)}</td>
        </tr>
        {open
          ? task.children.map((child) => {
              const entry = byId.get(child);
              if (!entry || path.has(child)) return null;
              return rows(entry, depth + 1, new Set([...path, child]));
            })
          : null}
      </Fragment>
    );
  };

  return (
    <section className="panel">
      <h2 className="panel-title">
        By task
        <span className="panel-subtitle">a split task counts the tasks it was split into</span>
      </h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th className="num">Iterations</th>
              <th className="num">Planning</th>
              <th className="num">Tokens</th>
              <th className="num">Inference</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>{roots.map((task) => rows(task, 0, new Set([task.id])))}</tbody>
        </table>
      </div>
    </section>
  );
}

/** Every turn spent on a task, and on the tasks split from it. */
function TaskTurns({ data, taskId }: { data: MetricsView; taskId: string }) {
  const task = data.tasks.find((entry) => entry.id === taskId);
  const family = useMemo(() => {
    const ids = new Set<string>();
    const visit = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of data.tasks.find((entry) => entry.id === id)?.children ?? []) visit(child);
    };
    visit(taskId);
    return ids;
  }, [data.tasks, taskId]);
  const turns = data.turns.filter((turn) => turn.taskId !== null && family.has(turn.taskId));

  if (!task) return <div className="empty">Nothing recorded for {taskId}. <a href={href('metrics', 'tasks')}>All tasks</a></div>;
  return (
    <>
      <section className="cards">
        <div className="card">
          <div className="card-label">
            <a href={href('metrics', 'tasks')}>Tasks</a> / {task.id}
          </div>
          <div className="card-value metrics-card-title" title={task.title ?? undefined}>
            {task.title ?? <span className="muted">split</span>}
          </div>
          <div className="card-detail">
            {task.parent ? <>Split from <a href={href('metrics', `tasks/${task.parent}`)}>{task.parent}</a></> : null}
            {task.children.length ? `Split into ${task.children.join(', ')}` : null}
            {!task.parent && !task.children.length ? (task.passes ? 'Passes' : task.passes === false ? 'Open' : '–') : null}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Iterations</div>
          <div className="card-value">{task.total.iterations}</div>
          <div className="card-detail">
            {task.total.planningTurns} planning turn{task.total.planningTurns === 1 ? '' : 's'}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Tokens</div>
          <div className="card-value">{formatCount(task.total.tokens)}</div>
          <div className="card-detail">{formatDuration(task.total.inferenceMs)} inference</div>
        </div>
        <div className="card">
          <div className="card-label">Estimated cost</div>
          <div className="card-value">{task.total.estimatedCost !== null ? formatMoney(task.total.estimatedCost, data.cost.currency) : <span className="muted">not set</span>}</div>
          <div className="card-detail">{task.children.length ? 'with the tasks split from it' : ' '}</div>
        </div>
      </section>
      <section className="panel">
        <h2 className="panel-title">
          Turns
          <span className="panel-subtitle">{turns.length}</span>
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Turn</th>
                <th>Task</th>
                <th>Models</th>
                <th className="num">Tokens</th>
                <th className="num">Inference</th>
                <th className="num">Wall</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {[...turns].reverse().map((turn) => (
                <tr key={`${turn.runId}-${turn.kind}-${turn.iteration}-${turn.escalation ?? turn.taskId}`} className={turn.kind === 'iteration' ? undefined : 'split-row'}>
                  <td>{formatDateTime(turn.startedAt)}</td>
                  <td>
                    <a href={href('transcript', `${turn.runId}/${turnSession(turn)}`)} title="Open the transcript">
                      {turn.kind === 'iteration' ? `iteration ${turn.iteration}` : turn.kind === 'assessment' ? 'assess' : turn.kind === 'escalation' ? 'escalation' : 'split'}
                    </a>
                    {turn.source === 'legacy' || turn.source === 'none' ? <span className="pill warn metrics-approx" title="Recorded before Ralph recorded usage">approx.</span> : null}
                  </td>
                  <td>{turn.taskId}</td>
                  <td className="metrics-models">{turn.models.join(', ') || '–'}</td>
                  <td className="num">{formatCount(turn.tokens)}</td>
                  <td className="num">{formatDuration(turn.inferenceMs)}</td>
                  <td className="num">{formatDuration(turn.wallMs)}</td>
                  <td className="num">{costCell(turn, data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Runs({ data }: { data: MetricsView }) {
  return (
    <section className="panel">
      <h2 className="panel-title">
        By run
        <span className="panel-subtitle">{data.runs.length}</span>
      </h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th className="num">Iterations</th>
              <th className="num">Planning</th>
              <th className="num">Tokens</th>
              <th className="num">Inference</th>
              <th className="num">Wall</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.runId}>
                <td>
                  <a href={href('transcript', run.runId)} title="Open its transcripts">
                    {run.startedAt ? formatDateTime(run.startedAt) : formatRunId(run.runId)}
                  </a>
                </td>
                <td>
                  <span className={`badge tone-${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                </td>
                <td className="num">{run.iterations}</td>
                <td className="num">{run.planningTurns}</td>
                <td className="num">{formatCount(run.tokens)}</td>
                <td className="num">{formatDuration(run.inferenceMs)}</td>
                <td className="num">{formatDuration(run.wallMs)}</td>
                <td className="num">{costCell(run, data)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function costCell(usage: MetricsUsage, data: MetricsView): string {
  if (usage.estimatedCost !== null) return formatMoney(usage.estimatedCost, data.cost.currency);
  return usage.reportedCost > 0 ? formatMoney(usage.reportedCost, 'USD') : '–';
}

function tokenBreakdown(usage: MetricsUsage): string {
  return [
    `${usage.input.toLocaleString()} input`,
    `${usage.output.toLocaleString()} output`,
    `${usage.reasoning.toLocaleString()} reasoning`,
    `${usage.cacheRead.toLocaleString()} cache read`,
    `${usage.cacheWrite.toLocaleString()} cache write`,
  ].join('\n');
}

/** An amount in `currency`: a code formats as one, anything else is put after the number. */
export function formatMoney(amount: number, currency: string): string {
  const digits =
    amount !== 0 && Math.abs(amount) < 0.1
      ? { minimumSignificantDigits: 2, maximumSignificantDigits: 2 }
      : { maximumFractionDigits: 2, minimumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, ...digits }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(undefined, digits).format(amount)} ${currency}`;
  }
}

/** The width of the element `ref` is put on, as it resizes. */
function useWidth(initial: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setWidth(Math.max(240, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function zero(withCost: boolean): MetricsUsage {
  return { steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, inferenceMs: 0, reportedCost: 0, estimatedCost: withCost ? 0 : null };
}

function add(into: MetricsUsage, from: MetricsUsage): void {
  into.steps += from.steps;
  into.input += from.input;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.tokens += from.tokens;
  into.inferenceMs += from.inferenceMs;
  into.reportedCost += from.reportedCost;
  if (into.estimatedCost !== null) into.estimatedCost += from.estimatedCost ?? 0;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A round top for the axis, with a round half: 1, 2, 4 or 5 times a power of ten, or whole minutes and hours for time. */
function niceMax(value: number, measure: Measure): number {
  if (value <= 0) return measure === 'inferenceMs' ? 60_000 : 1;
  if (measure === 'inferenceMs') {
    for (const step of [60_000, 300_000, 900_000, 1_800_000, 3_600_000]) if (value <= step * 2) return Math.ceil(value / step) * step;
    return Math.ceil(value / 3_600_000) * 3_600_000;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 4, 5, 10]) if (value <= factor * power) return factor * power;
  return 10 * power;
}

/** A bar anchored to the baseline, rounded only at its data end. */
function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** The turn's session in the Transcript tab's URL. */
function turnSession(turn: MetricsTurn): string {
  if (turn.kind === 'iteration') return String(turn.iteration);
  if (turn.kind === 'escalation') return `escalation-${turn.escalation ?? ''}`;
  return `split-${turn.taskId}`;
}
