import { useState } from 'react';
import { forgetToken, hasToken, postJson, rememberToken, useNow, type AskView, type FormField, type FormValue, type StatusView } from '../api';
import { answerableFields, checkFormAnswer, cleanAnswer, fieldVisible, type FormAnswer } from '../../../src/ui/form-check.js';
import { formatDuration } from '../format';

export function askTitle(ask: AskView): string {
  if (ask.kind === 'permission') return 'The agent asks for a permission';
  return ask.form?.source === 'mcp' ? `An MCP server asks: ${ask.form.title}` : `The agent asks: ${ask.form?.title ?? 'a question'}`;
}

/** The forms and permissions waiting on a person, from runs or from the planner. */
export function Asks({ status, origin }: { status: StatusView; origin: AskView['origin'] }) {
  const asks = status.asks.filter((ask) => ask.origin === origin);
  if (asks.length === 0) return null;
  return (
    <>
      {asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} status={status} />
      ))}
    </>
  );
}

function initialAnswer(fields: FormField[]): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of fields) {
    if ('default' in field && field.default !== undefined) answer[field.key] = field.default;
  }
  return answer;
}

function AskCard({ ask, status }: { ask: AskView; status: StatusView }) {
  const { actions } = status;
  const fields = ask.form?.fields ?? [];
  const [answer, setAnswer] = useState<FormAnswer>(() => initialAnswer(fields));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(() => !hasToken());
  const now = useNow(10_000);
  const askToken = Boolean(actions?.token) && needsToken;

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await postJson<{ message: string }>('/api/actions/ask', { id: ask.id, ...body });
      setSent(result.message);
      setNeedsToken(false);
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

  const set = (key: string, value: FormValue | undefined) =>
    setAnswer((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const problems = ask.kind === 'form' ? checkFormAnswer(fields, cleanAnswer(fields, answer)) : [];
  const left = ask.expiresAt ? Date.parse(ask.expiresAt) - now : null;

  return (
    <section className="panel pending ask" aria-label="Needs you">
      <h2 className="panel-title">
        <span className="badge tone-warn">Needs you</span>
        {askTitle(ask)}
        <span className="panel-subtitle">
          {ask.taskId ? `${ask.taskId} · ` : ''}the agent waits for your answer
          {left !== null ? ` · ${left > 0 ? `${formatDuration(left)} left` : 'time is up'}` : ''}
        </span>
      </h2>

      <div className="pending-body">
        {ask.permission ? (
          <div className="ask-permission">
            <p className="pending-question">
              <code>{ask.permission.action}</code>
            </p>
            {ask.permission.resources.length > 0 ? (
              <ul className="ask-resources">
                {ask.permission.resources.map((resource) => (
                  <li key={resource}>
                    <code>{resource}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {ask.permission.message ? <p className="muted">{ask.permission.message}</p> : null}
          </div>
        ) : null}

        {ask.error ? (
          <div className="banner bad" role="alert">
            opencode did not take the last answer: {ask.error}
          </div>
        ) : null}

        {!actions?.enabled ? (
          <div className="banner warn">{actions?.reason ?? 'This web UI takes no actions.'}</div>
        ) : ask.answered || sent ? (
          <div className="banner good" role="status">
            {sent ?? 'Answer sent.'} {ask.answered ? 'Ralph is handing it on…' : ''}
          </div>
        ) : (
          <form
            className="ask-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (ask.kind === 'form' && problems.length === 0) void send({ answer: cleanAnswer(fields, answer) });
            }}
          >
            {askToken ? (
              <label className="pending-field">
                <span>Web UI token (ui.token)</span>
                <input type="password" autoComplete="off" onChange={(event) => rememberToken(event.target.value)} />
              </label>
            ) : null}

            {ask.kind === 'form'
              ? fields
                  .filter((field) => fieldVisible(field, answer))
                  .map((field) => <Field key={field.key} field={field} value={answer[field.key]} onChange={(value) => set(field.key, value)} />)
              : null}

            {ask.kind === 'form' ? (
              <label className="pending-field">
                <span>Or decline, with a note for the agent (optional)</span>
                <input type="text" className="ask-input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why, or what to do instead" />
              </label>
            ) : null}

            {error ? (
              <div className="banner bad" role="alert">
                {error}
              </div>
            ) : null}

            <div className="pending-actions">
              {ask.kind === 'form' ? (
                <>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy || problems.length > 0 || answerableFields(fields, answer).length === 0}
                    title={problems.join('\n') || undefined}
                  >
                    Send answer
                  </button>
                  <button type="button" className="button" disabled={busy} onClick={() => void send({ cancel: note.trim() })}>
                    Decline
                  </button>
                  {problems.length > 0 ? <span className="muted small">{problems[0]}</span> : null}
                </>
              ) : (
                <>
                  <button type="button" className="button primary" disabled={busy} onClick={() => void send({ decision: 'once' })}>
                    Allow once
                  </button>
                  <button type="button" className="button" disabled={busy} onClick={() => void send({ decision: 'always' })}>
                    Always allow
                  </button>
                  <button type="button" className="button danger" disabled={busy} onClick={() => void send({ decision: 'reject' })}>
                    Reject
                  </button>
                </>
              )}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

/** One field of a form, as its type asks to be answered. */
function Field({ field, value, onChange }: { field: FormField; value: FormValue | undefined; onChange: (value: FormValue | undefined) => void }) {
  const label = (
    <span>
      {field.title ?? field.key}
      {field.required ? <span className="ask-required" aria-label="required"> *</span> : null}
    </span>
  );
  const description = field.description ? <span className="muted small">{field.description}</span> : null;

  switch (field.type) {
    case 'external':
      return (
        <div className="pending-field">
          {label}
          {description}
          <a href={field.url} target="_blank" rel="noreferrer noopener">
            {field.url}
          </a>
        </div>
      );
    case 'boolean':
      return (
        <label className="pending-field inline ask-check">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          {label}
          {description}
        </label>
      );
    case 'number':
    case 'integer':
      return (
        <label className="pending-field">
          {label}
          {description}
          <input
            type="number"
            className="ask-input"
            step={field.type === 'integer' ? 1 : 'any'}
            {...(typeof field.minimum === 'number' ? { min: field.minimum } : {})}
            {...(typeof field.maximum === 'number' ? { max: field.maximum } : {})}
            value={typeof value === 'number' ? value : ''}
            onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
          />
        </label>
      );
    case 'multiselect': {
      const picked = Array.isArray(value) ? value : [];
      const custom = picked.filter((entry) => !field.options.some((option) => option.value === entry));
      const toggle = (entry: string, on: boolean) => onChange(on ? [...picked, entry] : picked.filter((each) => each !== entry));
      return (
        <fieldset className="pending-field ask-choices">
          <legend>{label}</legend>
          {description}
          {field.options.map((option) => (
            <label key={option.value} className="ask-choice">
              <input type="checkbox" checked={picked.includes(option.value)} onChange={(event) => toggle(option.value, event.target.checked)} />
              <span>
                {option.label}
                {option.description ? <span className="muted small"> · {option.description}</span> : null}
              </span>
            </label>
          ))}
          {field.custom ? (
            <input
              type="text"
              className="ask-input"
              placeholder="Others, comma-separated"
              value={custom.join(', ')}
              onChange={(event) => {
                const others = event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean);
                onChange([...picked.filter((entry) => field.options.some((option) => option.value === entry)), ...others]);
              }}
            />
          ) : null}
        </fieldset>
      );
    }
    case 'string': {
      const text = typeof value === 'string' ? value : '';
      if (field.options?.length) {
        const isOption = field.options.some((option) => option.value === text);
        return (
          <fieldset className="pending-field ask-choices">
            <legend>{label}</legend>
            {description}
            {field.options.map((option) => (
              <label key={option.value} className="ask-choice">
                <input type="radio" name={field.key} checked={text === option.value} onChange={() => onChange(option.value)} />
                <span>
                  {option.label}
                  {option.description ? <span className="muted small"> · {option.description}</span> : null}
                </span>
              </label>
            ))}
            {field.custom ? (
              <input
                type="text"
                className="ask-input"
                placeholder="Something else"
                value={isOption ? '' : text}
                onChange={(event) => onChange(event.target.value || undefined)}
              />
            ) : null}
          </fieldset>
        );
      }
      const long = (field.maxLength ?? 0) > 200 || (!field.format && !field.maxLength && !field.pattern);
      return (
        <label className="pending-field">
          {label}
          {description}
          {long ? (
            <textarea rows={3} value={text} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value || undefined)} />
          ) : (
            <input
              type={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : field.format === 'date-time' ? 'datetime-local' : 'text'}
              className="ask-input"
              value={text}
              placeholder={field.placeholder}
              onChange={(event) => onChange(event.target.value || undefined)}
            />
          )}
        </label>
      );
    }
  }
}
