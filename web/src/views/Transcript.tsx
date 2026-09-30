import { memo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useJson, useStickToBottom, type LiveState, type RunDetail, type RunView, type StatusView, type TranscriptEntry } from '../api';
import { formatClock, formatCount, formatRunId, statusLabel } from '../format';
import { href } from '../route';

/**
 * The transcript of one iteration. With nothing picked it follows the
 * latest run's iteration in progress and moves on to the next one as it
 * starts; `selected` (`<runId>/<iteration>`) pins another.
 */
export function Transcript({
  status,
  live,
  selected,
}: {
  status: StatusView;
  live: LiveState['transcript'];
  selected: string;
}) {
  const [pickedRun, pickedIteration] = selected.split('/');
  const following = !pickedRun;
  const runId = pickedRun || live?.runId || status.run?.runId || null;

  const runs = useJson<RunView[]>('/api/runs', status.run?.runId ?? null);
  const detail = useJson<RunDetail>(
    runId ? `/api/runs/${encodeURIComponent(runId)}` : null,
    runId === status.run?.runId ? `${status.run.updatedAt}:${status.run.iteration}` : null,
  );
  const iterations = detail.data?.iterations ?? [];
  const lastIteration = iterations.at(-1)?.iteration ?? (live?.runId === runId ? live?.iteration : undefined);
  const iteration = pickedIteration
    ? Number(pickedIteration)
    : following && live?.runId === runId
      ? live.iteration
      : lastIteration;

  const isLive = live !== null && live.runId === runId && live.iteration === iteration;
  const fetched = useJson<TranscriptEntry[]>(
    !isLive && runId && iteration ? `/api/runs/${encodeURIComponent(runId)}/iterations/${iteration}/transcript` : null,
  );
  const entries = isLive ? live.entries : (fetched.data ?? []);
  const inProgress = isLive && status.run?.live === true && status.run.runId === runId;

  const { ref, stuck, onScroll, jump } = useStickToBottom<HTMLDivElement>(entries);
  const info = iterations.find((entry) => entry.iteration === iteration);

  return (
    <div className="transcript-view">
      <div className="toolbar">
        <label className="field">
          <span>Run</span>
          <select
            value={runId ?? ''}
            onChange={(event) => (window.location.hash = href('transcript', event.target.value))}
          >
            {(runs.data ?? (runId ? [{ runId, status: '' } as RunView] : [])).map((run) => (
              <option key={run.runId} value={run.runId}>
                {formatRunId(run.runId)} · {run.live ? 'running' : statusLabel(run.status)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Iteration</span>
          <select
            value={iteration ?? ''}
            onChange={(event) => (window.location.hash = href('transcript', `${runId}/${event.target.value}`))}
          >
            {iteration && !iterations.some((entry) => entry.iteration === iteration) ? (
              <option value={iteration}>{iteration}</option>
            ) : null}
            {iterations.map((entry) => (
              <option key={entry.iteration} value={entry.iteration}>
                {entry.iteration} · {entry.taskId ?? '–'} · {statusLabel(entry.status)}
              </option>
            ))}
          </select>
        </label>
        <div className="toolbar-spacer" />
        {inProgress ? (
          <span className="badge tone-live">
            <span className="pulse" />
            {following ? 'Following live' : 'Live'}
          </span>
        ) : info ? (
          <span className="muted small">{statusLabel(info.status)}</span>
        ) : null}
        {!following ? (
          <a className="button" href={href('transcript')}>
            Follow latest
          </a>
        ) : null}
      </div>

      <div className="transcript-scroll" ref={ref} onScroll={onScroll}>
        {fetched.error && !isLive ? <div className="banner bad">{fetched.error}</div> : null}
        {!iteration ? (
          <div className="empty">No iterations yet. The transcript appears here as soon as one starts.</div>
        ) : entries.length === 0 ? (
          <div className="empty">{inProgress ? 'Waiting for the agent…' : 'Nothing recorded for this iteration.'}</div>
        ) : (
          <ol className="entries">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
            {inProgress ? (
              <li className="entry working">
                <span className="typing" aria-label="working">
                  <i />
                  <i />
                  <i />
                </span>
              </li>
            ) : null}
          </ol>
        )}
      </div>
      {!stuck && inProgress ? (
        <button type="button" className="jump" onClick={jump}>
          ↓ Latest
        </button>
      ) : null}
    </div>
  );
}

const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  const time = <time className="entry-time">{formatClock(entry.time)}</time>;
  const tag = entry.subagent ? <span className="pill">subagent</span> : null;

  switch (entry.kind) {
    case 'prompt':
      return (
        <li className="entry prompt">
          {time}
          <details className="entry-body">
            <summary>
              <span className="entry-kind">Prompt</span> {tag}
              <span className="muted small"> {entry.text.length.toLocaleString()} characters</span>
            </summary>
            <pre className="pre">{entry.text}</pre>
          </details>
        </li>
      );
    case 'text':
      return (
        <li className="entry text">
          {time}
          <div className="entry-body">
            {tag}
            <div className={entry.done ? 'markdown' : 'markdown streaming'}>
              <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
            </div>
          </div>
        </li>
      );
    case 'reasoning':
      return (
        <li className="entry reasoning">
          {time}
          <details className="entry-body">
            <summary>
              <span className="entry-kind">Thinking</span> {tag}
            </summary>
            <div className="reasoning-text">{entry.text}</div>
          </details>
        </li>
      );
    case 'tool':
      return <Tool entry={entry} time={time} tag={tag} />;
    case 'step':
      return (
        <li className="entry step">
          {time}
          <div className="entry-body step-line">
            {tag}
            model call · {formatCount(entry.tokens.input)} in
            {entry.tokens.cacheRead > 0 ? ` (+${formatCount(entry.tokens.cacheRead)} cached)` : ''} · {formatCount(entry.tokens.output)} out
            {entry.finish ? ` · ${entry.finish}` : ''}
          </div>
        </li>
      );
    case 'notice':
      return (
        <li className={`entry notice ${entry.level}`}>
          {time}
          <div className="entry-body">
            {tag} {entry.text}
          </div>
        </li>
      );
  }
});

function Tool({
  entry,
  time,
  tag,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool' }>;
  time: ReactNode;
  tag: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const icon = entry.status === 'running' ? '◌' : entry.status === 'success' ? '✓' : '✗';
  return (
    <li className={`entry tool ${entry.status}`}>
      {time}
      <details className="entry-body" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className={`tool-icon ${entry.status}`}>{icon}</span>
          <span className="tool-name">{entry.name}</span>
          <code className="tool-detail">{describe(entry.input)}</code>
          {entry.exit !== undefined && entry.exit !== 0 ? <span className="pill bad">exit {entry.exit}</span> : null}
          {tag}
        </summary>
        {open ? (
          <div className="tool-io">
            {entry.input ? (
              <>
                <div className="io-label">Input</div>
                <pre className="pre">{JSON.stringify(entry.input, null, 2)}</pre>
              </>
            ) : null}
            {entry.output ? (
              <>
                <div className="io-label">Output</div>
                <pre className="pre">{entry.output}</pre>
              </>
            ) : entry.status === 'running' ? (
              <div className="muted small">Running…</div>
            ) : null}
          </div>
        ) : null}
      </details>
    </li>
  );
}

/** The one input field that says what a tool call is about. */
function describe(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['command', 'filePath', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value.split('\n')[0]!;
  }
  const first = Object.values(input).find((value) => typeof value === 'string');
  return typeof first === 'string' ? first.split('\n')[0]! : '';
}
