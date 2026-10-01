import { useMemo, useState } from 'react';
import { useJson, useStickToBottom, type LiveState, type LogLine, type RunView, type StatusView } from '../api';
import { formatClock, formatRunId, statusLabel } from '../format';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Ralph's own log for a run: the latest (live) one unless another is picked. */
export function Logs({ status, live }: { status: StatusView; live: LiveState['log'] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [minLevel, setMinLevel] = useState<(typeof LEVELS)[number]>('info');
  const [query, setQuery] = useState('');

  const runId = picked ?? live?.runId ?? status.run?.runId ?? null;
  const isLive = live !== null && live.runId === runId;
  const runs = useJson<RunView[]>('/api/runs', status.run?.runId ?? null);
  const fetched = useJson<LogLine[]>(!isLive && runId ? `/api/runs/${encodeURIComponent(runId)}/log` : null);
  const lines = isLive ? live.lines : (fetched.data ?? []);

  const shown = useMemo(() => {
    const floor = LEVELS.indexOf(minLevel);
    const needle = query.trim().toLowerCase();
    return lines.filter(
      (line) =>
        LEVELS.indexOf(line.level) >= floor &&
        (!needle || `${line.message} ${line.fields ? JSON.stringify(line.fields) : ''}`.toLowerCase().includes(needle)),
    );
  }, [lines, minLevel, query]);

  const { ref, stuck, onScroll, jump } = useStickToBottom<HTMLDivElement>(shown.length);

  return (
    <div className="transcript-view">
      <div className="toolbar">
        <label className="field">
          <span>Run</span>
          <select value={runId ?? ''} onChange={(event) => setPicked(event.target.value)}>
            {(runs.data ?? []).map((run) => (
              <option key={run.runId} value={run.runId}>
                {formatRunId(run.runId)} · {run.live ? (run.status === 'waiting' ? 'waiting' : 'running') : statusLabel(run.status)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Level</span>
          <select value={minLevel} onChange={(event) => setMinLevel(event.target.value as (typeof LEVELS)[number])}>
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}+
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Filter</span>
          <input type="search" placeholder="Search messages" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>

      <div className="transcript-scroll log-scroll" ref={ref} onScroll={onScroll}>
        {fetched.error && !isLive ? <div className="banner bad">{fetched.error}</div> : null}
        {shown.length === 0 ? (
          <div className="empty">
            {lines.length === 0 ? (runId ? 'Nothing logged in this run yet.' : 'No runs yet.') : 'No lines match the filter.'}
          </div>
        ) : (
          <table className="log">
            <tbody>
              {shown.map((line, index) => (
                <tr key={index} className={`log-line ${line.level}`}>
                  <td className="log-time" title={line.time}>
                    {formatClock(line.time)}
                  </td>
                  <td className="log-level">{line.level}</td>
                  <td className="log-message">
                    {line.message}
                    {line.fields
                      ? Object.entries(line.fields).map(([key, value]) => (
                          <span key={key} className="log-field">
                            {' '}
                            <span className="log-key">{key}=</span>
                            {typeof value === 'string' ? value : JSON.stringify(value)}
                          </span>
                        ))
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!stuck && isLive ? (
        <button type="button" className="jump" onClick={jump}>
          ↓ Latest
        </button>
      ) : null}
    </div>
  );
}
