import { useState } from 'react';
import { forgetToken, hasToken, postJson, rememberToken, type PendingView, type StatusView } from '../api';
import { href } from '../route';

type Action = PendingView['actions'][number];

const LABELS: Record<Action, string> = {
  approve: 'Approve the split',
  retry: 'Try again without splitting',
  repropose: 'Ask for another proposal',
  answer: 'Send answer',
  resume: 'Resume',
  continue: 'Continue',
  stop: 'Stop the run',
  dismiss: 'Dismiss',
};

/** The action a person most likely wants, shown as the main button. */
const PRIMARY: Action[] = ['approve', 'answer', 'resume', 'continue'];

export function pendingTitle(pending: PendingView): string {
  switch (pending.kind) {
    case 'split':
      return `Review the proposed split of ${pending.taskId ?? 'the task'}`;
    case 'decide':
      return 'The agent needs a decision';
    case 'blocked':
      return 'The agent is blocked';
    case 'budget':
      return 'The iteration budget is spent';
    default:
      return pending.taskId ? `${pending.taskId} stalled` : 'The run stalled';
  }
}

/**
 * What the loop asks a person to settle, with the actions that settle it.
 * Also keeps the outcome of the last action on screen once the request is gone.
 */
export function Pending({ status }: { status: StatusView }) {
  const { pending, actions } = status;
  const [text, setText] = useState('');
  const [iterations, setIterations] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; message: string } | null>(null);
  // Once asked for, the token field stays until an action goes through: hiding it
  // as soon as a token is held would take it away at the first character typed.
  const [needsToken, setNeedsToken] = useState(() => !hasToken());

  if (!pending) {
    return done ? (
      <div className="banner good" role="status">
        {done.message}
      </div>
    ) : null;
  }

  const takesText = pending.actions.some((action) => action !== 'stop' && action !== 'approve' && action !== 'continue');
  const sent = pending.answered || done?.id === pending.id;
  const askToken = Boolean(actions?.token) && needsToken;

  const act = async (action: Action) => {
    const ending = status.daemon?.live ? 'The run ends as it would have without waiting, and the daemon goes idle.' : 'Ralph exits as it would have without waiting.';
    if (action === 'stop' && !window.confirm(`Stop the run? ${ending}`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postJson<{ message: string }>('/api/actions/respond', {
        id: pending.id,
        action,
        ...(text.trim() && action !== 'stop' && action !== 'approve' ? { text: text.trim() } : {}),
        ...(action === 'continue' ? { iterations } : {}),
      });
      setDone({ id: pending.id, message: result.message });
      setNeedsToken(false);
      setText('');
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status === 401) {
        forgetToken();
        setNeedsToken(true);
      }
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel pending" aria-label="Needs you">
      <h2 className="panel-title">
        <span className="badge tone-warn">Needs you</span>
        {pendingTitle(pending)}
        <span className="panel-subtitle">
          {pending.waiting
            ? 'Ralph is waiting for your answer'
            : status.daemon?.live
              ? 'The run has ended: settle this, then run another batch'
              : 'The run has ended: settle this, then run ralph again'}
        </span>
      </h2>

      <div className="pending-body">
        <p className={pending.kind === 'decide' ? 'pending-question' : 'pending-message'}>{pending.question ?? pending.message}</p>

        {pending.analysis ? (
          <div className="pending-analysis">
            <span className="muted small">The escalation agent passed this on:</span>
            <p>{pending.analysis}</p>
          </div>
        ) : null}

        {pending.split ? (
          <div className="pending-split">
            {pending.split.reason ? <p className="muted">{pending.split.reason}</p> : null}
            <ol>
              {pending.split.tasks.map((task) => (
                <li key={task.id}>
                  <span className="task-id">{task.id}</span> {task.title}{' '}
                  <a className="task-spec" href={href('files', task.specPath)} title="Open the proposed spec">
                    spec
                  </a>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {!actions?.enabled ? (
          <div className="banner warn">
            {actions?.reason ?? 'This web UI takes no actions.'} Answer from a terminal with <code>ralph respond</code>.
          </div>
        ) : sent ? (
          <div className="banner good" role="status">
            {pending.waiting ? 'Answer sent. Ralph is picking it up…' : (done?.message ?? 'Answer sent.')}
          </div>
        ) : (
          <>
            {askToken ? (
              <label className="pending-field">
                <span>Web UI token (ui.token)</span>
                <input
                  type="password"
                  autoComplete="off"
                  onChange={(event) => rememberToken(event.target.value)}
                />
              </label>
            ) : null}
            {takesText ? (
              <label className="pending-field">
                <span>{pending.actions.includes('answer') ? 'Your answer' : 'Note for the agent (optional)'}</span>
                <textarea
                  rows={3}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={
                    pending.kind === 'split'
                      ? 'What a new proposal should do differently, or what to try instead of splitting'
                      : pending.actions.includes('answer')
                        ? 'The agent reads this in its next iteration'
                        : 'What changed, or what the agent should do differently'
                  }
                />
              </label>
            ) : null}
            {pending.actions.includes('continue') ? (
              <label className="pending-field inline">
                <span>More iterations</span>
                <input type="number" min={1} max={10000} value={iterations} onChange={(event) => setIterations(Math.max(1, Number(event.target.value) || 1))} />
              </label>
            ) : null}
            {error ? (
              <div className="banner bad" role="alert">
                {error}
              </div>
            ) : null}
            <div className="pending-actions">
              {pending.actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`button ${PRIMARY.includes(action) ? 'primary' : action === 'stop' ? 'danger' : ''}`}
                  disabled={busy || (action === 'answer' && !text.trim())}
                  onClick={() => void act(action)}
                >
                  {LABELS[action]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Ask a run in progress to stop: after its iteration, at once, or parked (the
 * agent hands off, then the work is committed and pushed, to carry on
 * elsewhere). Under a daemon, that pauses it.
 */
export function StopButtons({ status }: { status: StatusView }) {
  const [state, setState] = useState<{ message: string; bad: boolean } | null>(null);
  const run = status.run;
  if (!run?.live || run.status === 'waiting' || !status.actions?.enabled) return null;
  const daemon = status.daemon?.live === true;

  const stop = async (mode: 'after-iteration' | 'now' | 'park') => {
    if (mode === 'now' && !window.confirm(`${daemon ? 'Pause' : 'Stop'} now? The iteration in progress is interrupted and its uncommitted work is left as it is.`)) return;
    if (mode === 'park' && !window.confirm('Park the run? The agent hands off at once, then its work is committed and pushed so the run can carry on elsewhere.')) return;
    try {
      const result = await postJson<{ message: string }>('/api/actions/stop', { mode });
      setState({ message: result.message, bad: false });
    } catch (cause) {
      setState({ message: (cause as Error).message, bad: true });
    }
  };

  return (
    <div className="stop-buttons">
      <button type="button" className="button small" onClick={() => void stop('after-iteration')}>
        {daemon ? 'Pause after this iteration' : 'Stop after this iteration'}
      </button>
      <button type="button" className="button small" onClick={() => void stop('park')}>
        Park
      </button>
      <button type="button" className="button small danger" onClick={() => void stop('now')}>
        {daemon ? 'Pause now' : 'Stop now'}
      </button>
      {state ? (
        <span className={state.bad ? 'stop-note bad' : 'stop-note'} role="status">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

/** Have an idle daemon run a batch of iterations. */
export function RunButtons({ status }: { status: StatusView }) {
  const daemon = status.daemon;
  const [iterations, setIterations] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ message: string; bad: boolean } | null>(null);
  // Once asked for, the token field stays until an action goes through: hiding it
  // as soon as a token is held would take it away at the first character typed.
  const [needsToken, setNeedsToken] = useState(() => !hasToken());
  if (!daemon?.live || daemon.status !== 'idle' || status.run?.live || !status.actions?.enabled) return null;
  const count = iterations ?? daemon.defaultIterations;
  const askToken = status.actions.token && needsToken;

  const run = async () => {
    setBusy(true);
    try {
      const result = await postJson<{ message: string }>('/api/actions/run', { iterations: count });
      setState({ message: result.message, bad: false });
      setNeedsToken(false);
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status === 401) {
        forgetToken();
        setNeedsToken(true);
      }
      setState({ message: failure.message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stop-buttons">
      {askToken ? (
        <input
          className="run-token"
          type="password"
          autoComplete="off"
          placeholder="ui.token"
          aria-label="Web UI token (ui.token)"
          onChange={(event) => rememberToken(event.target.value)}
        />
      ) : null}
      <input
        className="run-iterations"
        type="number"
        min={1}
        max={10000}
        value={count}
        aria-label="Iterations to run"
        onChange={(event) => setIterations(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))}
      />
      <button type="button" className="button small primary" disabled={busy} onClick={() => void run()}>
        Run {count} iteration{count === 1 ? '' : 's'}
      </button>
      {state ? (
        <span className={state.bad ? 'stop-note bad' : 'stop-note'} role="status">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
