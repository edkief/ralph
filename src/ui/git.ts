import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NotFoundError } from './project.js';
import type { GitCommitDetail, GitCommitSummary, GitFileChange, GitFileStat, GitView } from './types.js';

const run = promisify(execFile);

const MAX_COMMITS = 50;
/** Files listed for the working tree or for one commit. */
const MAX_FILES = 500;
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** What a commit route takes: an abbreviated or full object name, and nothing git would read as an option or a ref. */
export const COMMIT_HASH = /^[0-9a-f]{4,64}$/i;

const FIELD = '\x1f';
const SUMMARY_FORMAT = ['%H', '%h', '%an', '%aI', '%s'].join('%x1f');
const DETAIL_FORMAT = ['%H', '%h', '%an', '%aI', '%s', '%P', '%ae', '%b'].join('%x1f');

const STATUS: Record<string, GitFileChange['status']> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

/**
 * Run git in the project, read-only: no shell, no prompt, and no lock on the
 * index, so asking for the status never gets in the way of the agent's own git.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

function reasonOf(cause: unknown): string {
  const error = cause as Error & { code?: unknown; stderr?: string };
  if (error.code === 'ENOENT') return 'git is not installed';
  const stderr = (error.stderr ?? '').trim();
  if (/not a git repository/i.test(stderr)) return 'The project is not a git repository';
  return (stderr.split('\n')[0] || error.message).replace(/^fatal: /, '');
}

/** The repository as it stands: the branch, what is uncommitted, and the latest commits. */
export async function gitStatus(cwd: string): Promise<GitView> {
  let status: string;
  try {
    status = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  } catch (cause) {
    return { available: false, reason: reasonOf(cause) };
  }

  const view: Extract<GitView, { available: true }> = {
    available: true,
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    changesTruncated: false,
    commits: [],
  };

  const add = (change: GitFileChange) => {
    if (view.changes.length < MAX_FILES) view.changes.push(change);
    else view.changesTruncated = true;
  };
  const entries = status.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.startsWith('# branch.oid ')) {
      const oid = entry.slice('# branch.oid '.length);
      view.head = oid === '(initial)' ? null : oid;
    } else if (entry.startsWith('# branch.head ')) {
      const name = entry.slice('# branch.head '.length);
      view.branch = name === '(detached)' ? null : name;
    } else if (entry.startsWith('# branch.upstream ')) {
      view.upstream = entry.slice('# branch.upstream '.length);
    } else if (entry.startsWith('# branch.ab ')) {
      const ab = /\+(\d+) -(\d+)/.exec(entry);
      view.ahead = Number(ab?.[1] ?? 0);
      view.behind = Number(ab?.[2] ?? 0);
    } else if (entry.startsWith('? ')) {
      add({ path: entry.slice(2), status: 'untracked', staged: false, unstaged: true });
    } else if (entry.startsWith('u ')) {
      add({ path: fieldsFrom(entry, 10), status: 'conflicted', staged: false, unstaged: true });
    } else if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      const renamed = entry.startsWith('2 ');
      const [x = '.', y = '.'] = entry.slice(2, 4);
      // A rename's original path follows as an entry of its own.
      const from = renamed ? entries[++index] : undefined;
      add({
        path: fieldsFrom(entry, renamed ? 9 : 8),
        status: STATUS[x !== '.' ? x : y] ?? 'modified',
        staged: x !== '.',
        unstaged: y !== '.',
        ...(from ? { from } : {}),
      });
    }
  }

  // `git log` fails in a repository without a commit.
  if (view.head) {
    const log = await git(cwd, ['log', '-n', String(MAX_COMMITS), '-z', `--format=${SUMMARY_FORMAT}`]);
    view.commits = log.split('\0').filter(Boolean).map(summaryOf);
  }
  return view;
}

/** One commit: its message and the files it changed. A merge is compared with its first parent. */
export async function gitCommit(cwd: string, hash: string): Promise<GitCommitDetail> {
  if (!COMMIT_HASH.test(hash)) throw new NotFoundError(`No commit ${hash}`);
  const commit = `${hash}^{commit}`;
  let header: string;
  let numstat: string;
  try {
    [header, numstat] = await Promise.all([
      git(cwd, ['show', '--no-patch', `--format=${DETAIL_FORMAT}`, '--end-of-options', commit]),
      git(cwd, ['show', '--numstat', '-z', '-M', '--format=', '--diff-merges=first-parent', '--end-of-options', commit]),
    ]);
  } catch {
    throw new NotFoundError(`No commit ${hash}`);
  }

  const fields = header.split(FIELD);
  const files: GitFileStat[] = [];
  let filesChanged = 0;
  let added = 0;
  let removed = 0;
  const entries = numstat.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const stat = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entries[index]!.replace(/^\n+/, ''));
    if (!stat) continue;
    // A rename has no path of its own: the old and the new one follow.
    const from = stat[3] === '' ? entries[++index] : undefined;
    const path = stat[3] === '' ? (entries[++index] ?? '') : stat[3]!;
    const binary = stat[1] === '-';
    const file = { path, added: binary ? 0 : Number(stat[1]), removed: binary ? 0 : Number(stat[2]), binary, ...(from ? { from } : {}) };
    filesChanged += 1;
    added += file.added;
    removed += file.removed;
    if (files.length < MAX_FILES) files.push(file);
  }

  return {
    ...summaryOf(fields.slice(0, 5).join(FIELD)),
    parents: (fields[5] ?? '').split(' ').filter(Boolean),
    email: fields[6] ?? '',
    body: fields.slice(7).join(FIELD).trim(),
    files,
    filesChanged,
    added,
    removed,
  };
}

function summaryOf(record: string): GitCommitSummary {
  const [hash = '', shortHash = '', author = '', date = '', ...subject] = record.replace(/^\n+/, '').split(FIELD);
  return { hash, shortHash, author, date, subject: subject.join(FIELD) };
}

/** What follows the first `count` space-separated fields of a status entry: its path, spaces and all. */
function fieldsFrom(entry: string, count: number): string {
  let at = 0;
  for (let field = 0; field < count; field++) at = entry.indexOf(' ', at) + 1;
  return entry.slice(at);
}
