import { useEffect, useRef } from 'react';
import { useLive, useNow, type StatusView } from './api';
import { formatDuration, runBadge, statusLabel } from './format';
import { Overview } from './views/Overview';
import { Plan } from './views/Plan';
import { pendingTitle } from './views/Pending';
import { askTitle } from './views/Ask';
import { Tasks } from './views/Tasks';
import { Metrics } from './views/Metrics';
import { Transcript } from './views/Transcript';
import { Logs } from './views/Logs';
import { Files } from './views/Files';
import { Git } from './views/Git';
import { Notifications } from './views/Notifications';
import { TABS, href, useRoute } from './route';

export function App() {
  const live = useLive();
  const route = useRoute();
  const status = live.status;

  // The planner's question, when the owner answers it here.
  const planAsks = status?.plan?.live === true && status.plan.status === 'asking' && status.plan.by === 'daemon';
  // Forms and permissions an agent waits on, from a run or from the planner.
  const runAsk = status?.asks.find((ask) => ask.origin === 'run' && !ask.answered);
  const planAsk = status?.asks.find((ask) => ask.origin === 'plan' && !ask.answered);
  const planNeedsYou = planAsks || Boolean(planAsk);

  useEffect(() => {
    const run = status?.run;
    const state = status?.pending?.waiting || planNeedsYou || runAsk
      ? '⏸ needs you'
      : run?.live
        ? `▶ ${run.iteration}/${run.maxIterations ?? '?'}`
        : run
          ? statusLabel(run.status)
          : '';
    document.title = status ? `${status.project} · ${state || 'ralph'}` : 'Ralph';
  }, [status, planNeedsYou, runAsk]);

  // The header wraps on narrow screens; views that fill the window need its height.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = top.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--top-h', `${element.offsetHeight}px`);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="app">
      <div className="top" ref={top}>
        <Header status={status} connected={live.connected} />
        <nav className="tabs" aria-label="Views">
          <div className="tabs-inner">
            {TABS.map((tab) => (
              <a
                key={tab.id}
                href={href(tab.id)}
                className={route.tab === tab.id ? 'tab active' : 'tab'}
                aria-current={route.tab === tab.id ? 'page' : undefined}
              >
                {tab.label}
                {tab.id === 'overview' && (status?.pending || runAsk) ? <span className="needs-dot" aria-label="needs you" /> : null}
                {tab.id === 'plan' && planNeedsYou ? <span className="needs-dot" aria-label="needs you" /> : null}
                {tab.id === 'plan' && status?.plan?.live && !planNeedsYou ? <span className="live-dot" aria-label="live" /> : null}
                {tab.id === 'transcript' && status?.run?.live && status.run.status !== 'waiting' ? <span className="live-dot" aria-label="live" /> : null}
              </a>
            ))}
          </div>
        </nav>
      </div>
      <main className="main">
        {runAsk && route.tab !== 'overview' ? (
          <a className="banner warn needs-you" href={href('overview')}>
            <strong>Ralph needs you.</strong> {askTitle(runAsk)} →
          </a>
        ) : planAsk && route.tab !== 'plan' ? (
          <a className="banner warn needs-you" href={href('plan')}>
            <strong>Ralph needs you.</strong> {askTitle(planAsk)} →
          </a>
        ) : status?.pending && route.tab !== 'overview' ? (
          <a className="banner warn needs-you" href={href('overview')}>
            <strong>Ralph needs you.</strong> {pendingTitle(status.pending)} →
          </a>
        ) : planAsks && route.tab !== 'plan' ? (
          <a className="banner warn needs-you" href={href('plan')}>
            <strong>Ralph needs you.</strong> The planner has a question →
          </a>
        ) : null}
        {!status ? (
          <div className="empty">{live.connected ? 'Loading…' : 'Connecting to Ralph…'}</div>
        ) : route.tab === 'overview' ? (
          <Overview status={status} />
        ) : route.tab === 'plan' ? (
          <Plan status={status} live={live.plan} />
        ) : route.tab === 'tasks' ? (
          <Tasks status={status} />
        ) : route.tab === 'metrics' ? (
          <Metrics status={status} selected={route.rest} />
        ) : route.tab === 'transcript' ? (
          <Transcript status={status} live={live.transcript} selected={route.rest} />
        ) : route.tab === 'logs' ? (
          <Logs status={status} live={live.log} />
        ) : route.tab === 'files' ? (
          <Files status={status} selected={route.rest} />
        ) : (
          <Git selected={route.rest} />
        )}
      </main>
    </div>
  );
}

function Header({ status, connected }: { status: StatusView | null; connected: boolean }) {
  const now = useNow();
  const run = status?.run ?? null;
  const tasks = status?.tasks;
  const percent = tasks && tasks.total > 0 ? Math.round((tasks.passed / tasks.total) * 100) : 0;
  const badge = run ? runBadge(run) : null;
  const working = run?.live === true && run.status !== 'waiting';

  return (
    <header className="header">
      <div className="header-inner">
        <div className="brand">
          <img src="favicon.svg" alt="" width={22} height={22} />
          <div>
            <div className="brand-name">{status?.project ?? 'ralph'}</div>
            <div className="brand-path" title={status?.projectRoot}>
              {status ? `${status.ralphDir}/` : ''}
            </div>
          </div>
        </div>

        <div className="header-run">
          {run ? (
            <>
              <span className={`badge tone-${badge!.tone}`}>
                {badge!.pulse ? <span className="pulse" /> : null}
                {badge!.label}
              </span>
              <span className="header-iteration">
                <span className="label-full">Iteration</span>{' '}
                <span className="label-short" aria-hidden="true">
                  Iter
                </span>
                <strong>{run.iteration || '–'}</strong>
                {run.maxIterations ? <span className="muted">/{run.maxIterations}</span> : null}
                {run.taskId ? <span className="task-chip">{run.taskId}</span> : null}
                {/* The space sits outside the span, so a narrow header can wrap before the time. */}
                {working && run.split ? (
                  <>
                    {' '}
                    <span className="muted header-elapsed">
                      <span className="header-sep">· </span>
                      splitting · {formatDuration(now - Date.parse(run.split.startedAt))}
                    </span>
                  </>
                ) : working && run.iterationStartedAt ? (
                  <>
                    {' '}
                    <span className="muted header-elapsed">
                      <span className="header-sep">· </span>
                      {formatDuration(now - Date.parse(run.iterationStartedAt))}
                    </span>
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <span className="muted">No runs yet</span>
          )}
        </div>

        <div className="header-progress" title={tasks?.error ?? `${tasks?.passed ?? 0} of ${tasks?.total ?? 0} tasks pass`}>
          <div className="progress-label">
            <span className="progress-name">Tasks</span>
            <strong>
              {tasks?.passed ?? 0}/{tasks?.total ?? 0}
              <span className="progress-unit"> tasks</span>
            </strong>
          </div>
          <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <Notifications status={status} />

        <div className={connected ? 'connection ok' : 'connection down'} title={connected ? 'Receiving updates' : 'Reconnecting'}>
          <span className="connection-dot" />
          <span className="connection-label">{connected ? 'Live' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
}
