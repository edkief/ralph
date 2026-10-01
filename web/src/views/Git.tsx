import { useJson, useNow, type GitCommitDetail, type GitFileChange, type GitView } from '../api';
import { formatDateTime, type Tone } from '../format';
import { href } from '../route';

const CHANGE_TONE: Record<GitFileChange['status'], Tone> = {
  modified: 'warn',
  added: 'good',
  deleted: 'bad',
  renamed: 'live',
  copied: 'live',
  untracked: 'muted',
  conflicted: 'bad',
};

/** The project's repository: its branch, what is uncommitted, and the latest commits with what each changed. */
export function Git({ selected }: { selected: string }) {
  // The agent commits as it works: poll, as the Files view does.
  const tick = useNow(5000);
  const git = useJson<GitView>('/api/git', tick);
  const view = git.data;

  if (!view) return git.error ? <div className="banner bad">{git.error}</div> : <div className="empty">Loading…</div>;
  if (!view.available) return <div className="empty">{view.reason}.</div>;

  const hash = selected || view.commits[0]?.hash || null;
  const active = view.commits.find((commit) => commit.hash === hash || (hash !== null && commit.hash.startsWith(hash)));

  return (
    <div className="files git">
      <nav className="file-tree" aria-label="Repository">
        <div className="git-branch">
          <span className="task-chip">{view.branch ?? `detached at ${view.head?.slice(0, 7) ?? '–'}`}</span>
          {view.upstream ? (
            <span className="muted small" title={`Compared with ${view.upstream}, as last fetched`}>
              {view.upstream}
              {view.ahead ? ` ↑${view.ahead}` : ''}
              {view.behind ? ` ↓${view.behind}` : ''}
              {!view.ahead && !view.behind ? ' · up to date' : ''}
            </span>
          ) : (
            <span className="muted small">no upstream</span>
          )}
        </div>

        <div className="file-dir">Uncommitted changes{view.changes.length ? ` (${view.changes.length}${view.changesTruncated ? '+' : ''})` : ''}</div>
        {view.changes.length === 0 ? <div className="empty small">Working tree clean</div> : null}
        {view.changes.map((change) => (
          <div key={change.path} className="git-change" title={change.from ? `${change.from} → ${change.path}` : change.path}>
            <span className={`git-status tone-${CHANGE_TONE[change.status]}`}>{change.status}</span>
            <span className="git-path">{change.path}</span>
            {change.staged ? <span className="muted small">{change.unstaged ? 'partly staged' : 'staged'}</span> : null}
          </div>
        ))}
        {view.changesTruncated ? <div className="empty small">Only the first {view.changes.length} are listed.</div> : null}

        <div className="file-dir">Recent commits</div>
        {view.commits.length === 0 ? <div className="empty small">No commits yet</div> : null}
        {view.commits.map((commit) => (
          <a
            key={commit.hash}
            href={href('git', commit.hash)}
            className={commit === active ? 'git-commit active' : 'git-commit'}
            title={commit.subject}
          >
            <span className="git-subject">{commit.subject}</span>
            <span className="git-meta">
              <code>{commit.shortHash}</code> · {commit.author} · {formatDateTime(commit.date)}
            </span>
          </a>
        ))}
      </nav>

      <section className="file-view">
        {hash ? <Commit key={hash} hash={hash} /> : <div className="empty">No commits yet</div>}
      </section>
    </div>
  );
}

function Commit({ hash }: { hash: string }) {
  const commit = useJson<GitCommitDetail>(`/api/git/commits/${encodeURIComponent(hash)}`);
  const detail = commit.data;
  if (!detail) return commit.error ? <div className="banner bad">{commit.error}</div> : <div className="empty">Loading…</div>;

  return (
    <>
      <div className="file-header">
        <span className="file-path">{detail.subject}</span>
        <span className="muted small">
          {detail.author}
          {detail.email ? ` <${detail.email}>` : ''} · {formatDateTime(detail.date)}
        </span>
      </div>
      <div className="git-detail">
        <div className="muted small">
          commit <code>{detail.hash}</code>
          {detail.parents.length > 0 ? (
            <>
              {' · '}
              {detail.parents.length > 1 ? 'merge of ' : 'parent '}
              {detail.parents.map((parent, index) => (
                <span key={parent}>
                  {index > 0 ? ', ' : ''}
                  <a href={href('git', parent)}>
                    <code>{parent.slice(0, 7)}</code>
                  </a>
                </span>
              ))}
            </>
          ) : null}
        </div>
        {detail.body ? <pre className="pre">{detail.body}</pre> : null}

        <div className="git-totals">
          <strong>
            {detail.filesChanged} {detail.filesChanged === 1 ? 'file' : 'files'} changed
          </strong>
          <span className="git-added">+{detail.added}</span>
          <span className="git-removed">−{detail.removed}</span>
        </div>
        {detail.files.length > 0 ? (
          <div className="table-wrap">
            <table className="table git-files">
              <tbody>
                {detail.files.map((file) => (
                  <tr key={file.path}>
                    <td className="git-file">
                      {file.from ? <span className="muted">{file.from} → </span> : null}
                      {file.path}
                    </td>
                    {file.binary ? (
                      <td className="num muted" colSpan={2}>
                        binary
                      </td>
                    ) : (
                      <>
                        <td className="num git-added">+{file.added}</td>
                        <td className="num git-removed">−{file.removed}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {detail.files.length < detail.filesChanged ? (
          <div className="muted small">Only the first {detail.files.length} files are listed.</div>
        ) : null}
      </div>
    </>
  );
}
