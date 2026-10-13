import { useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiUrl, useJson, useNow, type FileContent, type FileEntry, type StatusView } from '../api';
import { formatBytes, formatDateTime } from '../format';
import { recognise } from '../ralph-files';
import { href } from '../route';
import { kindLabel, ralphFileView } from './RalphFile';

/** Files worth opening first, in this order, when none is picked. */
const PREFERRED = ['prd/PRD.md', 'tasks.json', 'PROMPT.md'];

/** Whether Ralph's records open readable or as they are, remembered in this browser. */
type ViewMode = 'formatted' | 'raw';
const VIEW_KEY = 'ralph-files-view';

function savedMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'raw' ? 'raw' : 'formatted';
  } catch {
    return 'formatted';
  }
}

function saveMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // Remembered for this page only.
  }
}

interface Group {
  dir: string;
  files: FileEntry[];
}

/** The Ralph folder's files grouped by directory, with a viewer. */
export function Files({ status, selected }: { status: StatusView; selected: string }) {
  // The agent edits these files as it works: poll the list, and reload the
  // open file when its modification time moves.
  const tick = useNow(5000);
  const list = useJson<FileEntry[]>('/api/files', tick);
  const files = list.data ?? [];
  const fallback = PREFERRED.map((path) => `${status.ralphDir}/${path}`).find((path) => files.some((file) => file.path === path));
  const path = selected || fallback || files[0]?.path || null;
  const entry = files.find((file) => file.path === path);
  const content = useJson<FileContent>(path ? `/api/file?path=${encodeURIComponent(path)}` : null, entry?.modifiedAt ?? null);
  const [mode, setMode] = useState<ViewMode>(savedMode);

  // Ralph's own records read better laid out; one cut short cannot be read whole.
  const file = content.data;
  const kind = file && !file.mediaType && !file.truncated ? recognise(file.path, status.ralphDir) : null;
  const formatted = useMemo(
    () => (file && kind ? ralphFileView(kind, file.content, { ralphDir: status.ralphDir, listed: new Set(files.map((listed) => listed.path)) }) : null),
    [file, kind, status.ralphDir, files],
  );
  const pick = (next: ViewMode) => {
    setMode(next);
    saveMode(next);
  };

  const groups = useMemo(() => {
    const byDir = new Map<string, FileEntry[]>();
    for (const file of files) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
    }
    return [...byDir.entries()]
      .map(([dir, entries]): Group => ({ dir, files: entries }))
      .sort((a, b) => (a.dir === '' ? 1 : b.dir === '' ? -1 : a.dir.localeCompare(b.dir)));
  }, [files]);

  return (
    <div className="files">
      <nav className="file-tree" aria-label="Files">
        {list.error ? <div className="banner bad">{list.error}</div> : null}
        {groups.map((group) => (
          <div key={group.dir} className="file-group">
            <div className="file-dir">{group.dir ? `${group.dir}/` : 'project root'}</div>
            {group.files.map((file) => (
              <a
                key={file.path}
                href={href('files', file.path)}
                className={file.path === path ? 'file active' : 'file'}
                title={file.path}
              >
                {file.path.slice(group.dir ? group.dir.length + 1 : 0)}
              </a>
            ))}
          </div>
        ))}
        {files.length === 0 && !list.error ? <div className="empty small">No files</div> : null}
      </nav>

      <section className="file-view">
        {!path ? (
          <div className="empty">Pick a file</div>
        ) : (
          <>
            <div className="file-header">
              <code className="file-path">{path}</code>
              {file ? (
                <span className="muted small">
                  {formatBytes(file.size)} · modified {formatDateTime(file.modifiedAt)}
                </span>
              ) : null}
              {formatted ? (
                <nav className="subtabs file-modes" aria-label="Show the file">
                  {(['formatted', 'raw'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={mode === option ? 'subtab active' : 'subtab'}
                      aria-pressed={mode === option}
                      onClick={() => pick(option)}
                    >
                      {option === 'formatted' ? 'Formatted' : 'Raw'}
                    </button>
                  ))}
                </nav>
              ) : kind ? (
                <span className="muted small">Shown as it is: it does not read as {kindLabel(kind)}</span>
              ) : null}
            </div>
            {content.error ? <div className="banner bad">{content.error}</div> : null}
            {file ? <FileBody file={file} formatted={mode === 'formatted' ? formatted : null} /> : null}
          </>
        )}
      </section>
    </div>
  );
}

/** `formatted` is the readable view of a Ralph record, shown in place of the file as it is. */
function FileBody({ file, formatted }: { file: FileContent; formatted: ReactNode | null }) {
  if (formatted) return formatted;
  if (file.mediaType) {
    // The modification time in the URL makes the browser fetch a changed image again.
    const src = apiUrl(`/api/file/raw?path=${encodeURIComponent(file.path)}&v=${encodeURIComponent(file.modifiedAt)}`);
    return <img className="image document" src={src} alt={file.path} />;
  }

  const truncated = file.truncated ? <div className="banner warn">Only the first 1 MB is shown.</div> : null;

  if (/\.(md|markdown)$/i.test(file.path)) {
    return (
      <>
        {truncated}
        {/* react-markdown never renders raw HTML, so agent-written files cannot inject script. */}
        <article className="markdown document">
          <Markdown remarkPlugins={[remarkGfm]}>{file.content}</Markdown>
        </article>
      </>
    );
  }

  let text = file.content;
  if (/\.json$/i.test(file.path) && !file.truncated) {
    try {
      text = JSON.stringify(JSON.parse(file.content), null, 2);
    } catch {
      // Show it as it is; the loop reports invalid JSON itself.
    }
  }
  return (
    <>
      {truncated}
      <pre className="pre document">{text}</pre>
    </>
  );
}
