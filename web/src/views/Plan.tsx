import { useState, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { forgetToken, hasToken, postJson, rememberToken, useJson, type LiveState, type PlanLineView, type PlanSummary, type PlanView, type StatusView } from '../api';
import { formatDateTime } from '../format';
import { href } from '../route';

/** Typed in the terminal, sent by **Write the plan now** here. */
const DONE_COMMAND = '/done';

/**
 * Plan the project with the agent, through the project's daemon: start an
 * interview (a new plan, or a revision of the one there is), hold the
 * conversation, and see how it ended. An interview `ralph init` holds in a
 * terminal shows here too, to follow.
 */
export function Plan({ status, live }: { status: StatusView; live: LiveState['plan'] }) {
  const plan = status.plan;
  // The live feed has the conversation of the session it follows; an older one is fetched.
  const followed = plan && live?.id === plan.id ? live.lines : null;
  const fetched = useJson<PlanView>(plan && !followed ? `/api/plans/${encodeURIComponent(plan.id)}` : null, plan ? `${plan.status}:${plan.seq}` : null);
  const conversation = followed ?? fetched.data?.conversation ?? [];

  return (
    <div className="stack">
      {plan ? <Session status={status} plan={plan} conversation={conversation} /> : null}
      {!plan?.live ? <Start status={status} /> : null}
    </div>
  );
}

/** An action's progress, and the token field it may need, as the other actions keep them. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ message: string; bad: boolean } | null>(null);
  // Once asked for, the token field stays until an action goes through: hiding it
  // as soon as a token is held would take it away at the first character typed.
  const [needsToken, setNeedsToken] = useState(() => !hasToken());

  const run = async (path: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await postJson<{ message: string }>(path, body);
      setState({ message: result.message, bad: false });
      setNeedsToken(false);
      return true;
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status === 401) {
        forgetToken();
        setNeedsToken(true);
      }
      setState({ message: failure.message, bad: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, state, needsToken, run };
}

function TokenField() {
  return (
    <label className="pending-field">
      <span>Web UI token (ui.token)</span>
      <input type="password" autoComplete="off" onChange={(event) => rememberToken(event.target.value)} />
    </label>
  );
}

/** Ctrl/Cmd-Enter sends, as in most chat boxes; Enter alone makes a new line. */
function onSend(send: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };
}

/** Start an interview: plan the project, or revise its plan. */
function Start({ status }: { status: StatusView }) {
  const [description, setDescription] = useState('');
  const action = useAction();
  const revise = status.planState === 'written';
  const { daemon, actions } = status;
  const blocked = !actions?.enabled ? (
    <>
      {actions?.reason ?? 'This web UI takes no actions.'} Plan in a terminal with <code>ralph init</code> instead.
    </>
  ) : !daemon?.live ? (
    <>
      Planning from here takes the project’s daemon, which holds the agent: start one with <code>ralph daemon</code>. Or plan in a terminal
      with <code>ralph init</code>.
    </>
  ) : daemon.status === 'planning'
        ? 'The daemon is planning already.'
        : daemon.status !== 'idle' || status.run?.live
          ? 'The daemon is running a batch: pause it, or wait for it to end, to plan.'
          : null;

  const start = async () => {
    if (!description.trim()) return;
    if (await action.run('/api/actions/plan/start', { mode: revise ? 'replan' : 'new', description: description.trim() })) setDescription('');
  };

  return (
    <section className="panel" aria-label={revise ? 'Revise the plan' : 'Plan this project'}>
      <h2 className="panel-title">
        {revise ? 'Revise the plan' : 'Plan this project'}
        <span className="panel-subtitle">{revise ? 'Say what should change; the agent asks about the rest' : 'Describe it, then answer the agent’s questions'}</span>
      </h2>
      <div className="pending-body">
        <p className="muted">
          {revise
            ? 'The agent reads the PRD and the tasks as they are, keeps what is done, and rewrites the rest with you.'
            : (
              <>
                The agent asks what it needs to know, then writes the PRD and the task list into {status.ralphDir}/. Missing files are laid out
                first, as <code>ralph init</code> does; nothing there is overwritten.
              </>
            )}
        </p>
        {blocked ? (
          <div className="banner warn">{blocked}</div>
        ) : (
          <>
            {actions?.token && action.needsToken ? <TokenField /> : null}
            <label className="pending-field">
              <span>{revise ? 'What should change' : 'The project: what it is, who it is for, what done looks like'}</span>
              <textarea
                rows={5}
                value={description}
                maxLength={20_000}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={onSend(() => void start())}
              />
            </label>
            <div className="pending-actions">
              <button type="button" className="button primary" disabled={action.busy || !description.trim()} onClick={() => void start()}>
                {revise ? 'Revise the plan' : 'Start planning'}
              </button>
            </div>
          </>
        )}
        {action.state ? (
          <div className={`banner ${action.state.bad ? 'bad' : 'good'}`} role="status">
            {action.state.message}
          </div>
        ) : null}
      </div>
    </section>
  );
}

const STATUS_LABELS: Record<PlanSummary['status'], string> = {
  starting: 'Starting',
  working: 'Agent working',
  asking: 'Your turn',
  planned: 'Plan written',
  invalid: 'Plan has problems',
  aborted: 'Stopped',
  failed: 'Failed',
};

const STATUS_TONES: Record<PlanSummary['status'], string> = {
  starting: 'live',
  working: 'live',
  asking: 'warn',
  planned: 'good',
  invalid: 'bad',
  aborted: 'muted',
  failed: 'bad',
};

/** The interview: its conversation, and the reply box while the agent waits, or how it ended. */
function Session({ status, plan, conversation }: { status: StatusView; plan: PlanSummary; conversation: PlanLineView[] }) {
  const working = plan.live && (plan.status === 'working' || plan.status === 'starting');
  const here = plan.by === 'daemon';
  return (
    <section className="panel plan-session" aria-label="Planning interview">
      <h2 className="panel-title">
        <span className={`badge tone-${STATUS_TONES[plan.status]}`}>
          {working ? <span className="pulse" /> : null}
          {STATUS_LABELS[plan.status]}
        </span>
        <span>{plan.mode === 'new' ? 'Planning the project' : 'Revising the plan'}</span>
        <span className="panel-subtitle">
          {[
            here ? null : 'in a terminal, with ralph init',
            plan.model,
            plan.turn > 0 ? `turn ${plan.turn}${plan.maxTurns ? `/${plan.maxTurns}` : ''}` : null,
            `since ${formatDateTime(plan.startedAt)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </h2>
      <ol className="plan-chat">
        {conversation.map((line, index) => (
          <li key={`${index}-${line.at}`} className={`plan-line ${line.role}`}>
            {line.role === 'agent' ? (
              // react-markdown never renders raw HTML, so the agent's text cannot inject script.
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
              </div>
            ) : line.role === 'owner' && line.text.trim() === DONE_COMMAND ? (
              <em>Write the plan now</em>
            ) : (
              line.text
            )}
          </li>
        ))}
        {working ? (
          <li className="plan-line activity">
            <span className="pulse" /> {plan.activity ?? (plan.status === 'starting' ? 'Getting ready…' : 'The agent is working…')}
          </li>
        ) : null}
      </ol>
      <div className="pending-body">
        {plan.live && !here ? (
          <div className="banner">
            Answer in the terminal where <code>ralph init</code> runs.
          </div>
        ) : plan.live ? (
          <Controls status={status} plan={plan} />
        ) : (
          <Outcome status={status} plan={plan} />
        )}
      </div>
    </section>
  );
}

/** Reply, have the plan written now, or stop. */
function Controls({ status, plan }: { status: StatusView; plan: PlanSummary }) {
  const [text, setText] = useState('');
  const [sentFor, setSentFor] = useState<number | null>(null);
  const action = useAction();
  const asking = plan.status === 'asking';
  const sent = sentFor === plan.seq;

  if (!status.actions?.enabled) {
    return <div className="banner warn">{status.actions?.reason ?? 'This web UI takes no actions.'}</div>;
  }

  const reply = async (done: boolean) => {
    if (!done && !text.trim()) return;
    const body = done ? { id: plan.id, seq: plan.seq, done: true } : { id: plan.id, seq: plan.seq, text: text.trim() };
    if (await action.run('/api/actions/plan/reply', body)) {
      setSentFor(plan.seq);
      setText('');
    }
  };
  const stop = async () => {
    if (!window.confirm('Stop planning? The agent is interrupted, and anything it wrote so far stays in .ralph/.')) return;
    await action.run('/api/actions/plan/stop', { id: plan.id });
  };

  return (
    <>
      {status.actions.token && action.needsToken ? <TokenField /> : null}
      {asking && !sent ? (
        <label className="pending-field">
          <span>{plan.prompt && plan.prompt !== 'you' ? plan.prompt : 'Your reply'}</span>
          <textarea
            rows={4}
            value={text}
            maxLength={20_000}
            autoFocus
            placeholder="Ctrl+Enter to send"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onSend(() => void reply(false))}
          />
        </label>
      ) : null}
      <div className="pending-actions">
        {asking && !sent ? (
          <>
            <button type="button" className="button primary" disabled={action.busy || !text.trim()} onClick={() => void reply(false)}>
              Send
            </button>
            <button
              type="button"
              className="button"
              disabled={action.busy}
              title="Stop the questions: the agent writes the plan, noting what is still open as assumptions"
              onClick={() => void reply(true)}
            >
              Write the plan now
            </button>
          </>
        ) : null}
        <button type="button" className="button danger" disabled={action.busy} onClick={() => void stop()}>
          Stop
        </button>
      </div>
      {action.state ? (
        <div className={`banner ${action.state.bad ? 'bad' : 'good'}`} role="status">
          {action.state.message}
        </div>
      ) : null}
    </>
  );
}

/** How the interview ended, and what to do next. */
function Outcome({ status, plan }: { status: StatusView; plan: PlanSummary }) {
  const outcome = plan.outcome;
  const ralphDir = `${status.ralphDir}/`;
  return (
    <>
      {plan.status === 'planned' ? (
        <div className="banner good">
          <strong>
            Plan written: {outcome?.tasks?.length ?? 0} task{outcome?.tasks?.length === 1 ? '' : 's'}.
          </strong>{' '}
          Review {ralphDir} and commit it, then run a batch.
        </div>
      ) : plan.status === 'invalid' ? (
        <div className="banner bad">
          <strong>The plan still has problems.</strong> Fix them by hand, or revise the plan.
        </div>
      ) : plan.status === 'failed' ? (
        <div className="banner bad">
          <strong>Planning failed.</strong> {outcome?.reason}
        </div>
      ) : (
        <div className="banner warn">
          <strong>Stopped.</strong> Anything the agent wrote is in {ralphDir}. Revise the plan to carry on.
        </div>
      )}
      {outcome?.tasks && outcome.tasks.length > 0 ? (
        <ul className="task-list">
          {outcome.tasks.map((task) => (
            <li key={task.id} className="task">
              <span className="task-id">{task.id}</span>
              <span className="task-title">{task.title}</span>
            </li>
          ))}
          <li className="task more">
            <a href={href('tasks')}>Open the Tasks tab</a>
          </li>
        </ul>
      ) : null}
      {outcome?.problems && outcome.problems.length > 0 ? (
        <ul className="plan-problems">
          {outcome.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {outcome?.outsideChanges && outcome.outsideChanges.length > 0 ? (
        <div className="banner warn">
          <strong>The agent changed files outside {ralphDir}:</strong> {outcome.outsideChanges.join(', ')}. Review them in the Git tab.
        </div>
      ) : outcome && outcome.outsideChanges === null ? (
        <div className="banner">Not a git repository: changes outside {ralphDir} could not be checked.</div>
      ) : null}
    </>
  );
}
