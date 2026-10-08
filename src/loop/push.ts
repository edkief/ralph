import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A commit on the remote branch that the local branch does not have. */
export interface RemoteOnlyCommit {
  sha: string;
  subject: string;
  /** An equivalent patch is in the local branch, e.g. the commit was amended or rebased. */
  equivalent: boolean;
}

/** The remote branch has commits the local one does not: a push would overwrite them. */
export interface Divergence {
  remote: string;
  branch: string;
  localSha: string;
  remoteSha: string;
  /** Oldest first. */
  commits: RemoteOnlyCommit[];
}

/** A diverged remote branch that was force-pushed over, and where its old tip is kept. */
export interface Overwrite extends Divergence {
  /** A local ref holding the old remote tip, which gc never prunes. */
  localRef: string;
  /** A branch on the remote holding the old remote tip. */
  backupBranch: string;
}

export type PushResult =
  | { ok: true; overwritten?: Overwrite }
  | { ok: false; error: string; diverged?: Divergence };

/**
 * Push the current branch to the same-named branch on `remote`.
 *
 * The loop pushes, not the agent: the agent keeps its `git push` deny rule, so
 * it can never force-push or rewrite remotes. Never prompts for credentials:
 * an unattended run must fail fast rather than hang.
 *
 * A rejected push is looked into: when the remote branch has commits the
 * local one does not (the agent rewrote history, or someone else pushed),
 * the result says so with those commits. With `force`, such a branch is
 * overwritten, but only once its old tip is kept both as a local ref and as a
 * backup branch on the remote, and with a lease on that tip, so nothing that
 * lands in between is lost.
 */
export async function pushBranch(
  cwd: string,
  remote: string,
  timeoutMs: number,
  options: { force?: boolean; now?: Date } = {},
): Promise<PushResult> {
  const git = (args: string[]) => gitOut(cwd, args, timeoutMs);
  try {
    await git(['push', remote, 'HEAD']);
    return { ok: true };
  } catch (cause) {
    const error = failure(cause);
    const diverged = await divergence(cwd, remote, timeoutMs);
    if (!diverged) return { ok: false, error };
    if (!options.force) return { ok: false, error, diverged };

    const stamp = timestamp(options.now ?? new Date());
    const localRef = `refs/ralph/overwritten/${diverged.branch}/${stamp}`;
    const backupBranch = `ralph/overwritten/${diverged.branch}-${stamp}`;
    try {
      await git(['update-ref', localRef, diverged.remoteSha]);
      await git(['push', remote, `${diverged.remoteSha}:refs/heads/${backupBranch}`]);
    } catch (backupFailure) {
      // No backup, no overwrite.
      return { ok: false, error: `could not back up ${remote}/${diverged.branch} before forcing: ${failure(backupFailure)}`, diverged };
    }
    try {
      await git([
        'push',
        `--force-with-lease=refs/heads/${diverged.branch}:${diverged.remoteSha}`,
        remote,
        `HEAD:refs/heads/${diverged.branch}`,
      ]);
    } catch (forceFailure) {
      return { ok: false, error: failure(forceFailure), diverged };
    }
    return { ok: true, overwritten: { ...diverged, localRef, backupBranch } };
  }
}

/** How the local branch and its remote counterpart diverged, if they did. */
async function divergence(cwd: string, remote: string, timeoutMs: number): Promise<Divergence | undefined> {
  const git = (args: string[]) => gitOut(cwd, args, timeoutMs);
  try {
    const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
    if (!branch) return undefined;
    await git(['fetch', '--no-tags', '--quiet', remote, `refs/heads/${branch}`]);
    const [remoteSha, localSha] = await Promise.all([git(['rev-parse', 'FETCH_HEAD']), git(['rev-parse', 'HEAD'])]);
    if (await isAncestor(cwd, remoteSha, localSha)) return undefined;
    // `-` marks a commit with an equivalent patch upstream, here the local branch.
    const commits = (await git(['cherry', '-v', localSha, remoteSha]))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [mark, sha = '', ...subject] = line.split(' ');
        return { sha, subject: subject.join(' '), equivalent: mark === '-' };
      });
    return { remote, branch, localSha, remoteSha, commits };
  } catch {
    // No such remote branch, no network: not a divergence anyone can tell.
    return undefined;
  }
}

async function isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
  try {
    await run('git', ['merge-base', '--is-ancestor', ancestor, of], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** What a diverged push would overwrite, and how to settle it, as lines for a person. */
export function describeDivergence(diverged: Divergence): string[] {
  const { remote, branch, commits } = diverged;
  return [
    `${remote}/${branch} (${short(diverged.remoteSha)}) has ${count(commits.length)} the local branch (${short(diverged.localSha)}) does not:` +
      ` its history was rewritten here, or someone else pushed.`,
    ...commitLines(commits, 'an equivalent patch is in the local branch', 'not in the local branch'),
    `Nothing was pushed. Reconcile the two (git fetch ${remote} ${branch}, then rebase, merge or cherry-pick), or set` +
      ` git.forcePush to overwrite ${remote}/${branch}, keeping a backup.`,
  ];
}

/** What a force-push overwrote, where it is kept, and how to get it back, as lines for a person. */
export function describeOverwrite(overwrite: Overwrite): string[] {
  const { remote, branch, commits, backupBranch } = overwrite;
  return [
    `Force-pushed ${branch} to ${remote} over diverged history: ${short(overwrite.remoteSha)} → ${short(overwrite.localSha)},` +
      ` overwriting ${count(commits.length)}:`,
    ...commitLines(commits, 'kept: an equivalent patch is in the new history', 'NOT in the new history'),
    `The old tip ${overwrite.remoteSha} is kept at ${overwrite.localRef} and at ${remote}/${backupBranch}.`,
    `To restore a commit: git fetch ${remote} ${backupBranch} && git cherry-pick <sha>.` +
      ` To restore the branch: git push --force ${remote} ${overwrite.remoteSha}:refs/heads/${branch}.`,
  ];
}

/** The commits as one line each, the first 20 of them. */
function commitLines(commits: RemoteOnlyCommit[], kept: string, lost: string): string[] {
  const shown = commits.slice(0, 20).map((commit) => `  ${short(commit.sha)} ${commit.subject} (${commit.equivalent ? kept : lost})`);
  return commits.length > 20 ? [...shown, `  … and ${commits.length - 20} more`] : shown;
}

function count(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** UTC, compact and safe in a ref name: 20261008T233000Z. */
function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

async function gitOut(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

function failure(cause: unknown): string {
  const error = cause as Error & { stderr?: string };
  return (error.stderr || error.message).trim();
}
