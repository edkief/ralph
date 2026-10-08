import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeDivergence, describeOverwrite, pushBranch } from '../src/loop/push.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A repository on `main` with a bare `origin` holding its first two commits, and a clone of it elsewhere. */
function setup() {
  const remote = mkdtempSync(resolve(tmpdir(), 'ralph-push-remote-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-push-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'remote', 'add', 'origin', remote);
  commit(root, 'a.txt', 'feat: one');
  commit(root, 'b.txt', 'feat: two');
  git(root, 'push', '-q', 'origin', 'HEAD');
  return { root, remote };
}

function commit(cwd: string, file: string, subject: string): string {
  writeFileSync(resolve(cwd, file), `${subject}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', subject);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Someone else pushes `subject` to origin/main. */
function pushElsewhere(remote: string, subject: string): string {
  const other = mkdtempSync(resolve(tmpdir(), 'ralph-push-other-'));
  git(other, 'clone', '-q', remote, '.');
  git(other, 'config', 'user.email', 'other@example.com');
  git(other, 'config', 'user.name', 'Other');
  const sha = commit(other, 'other.txt', subject);
  git(other, 'push', '-q', 'origin', 'HEAD');
  return sha;
}

const now = new Date('2026-10-08T23:30:00.000Z');

describe('pushBranch', () => {
  it('pushes a branch that is ahead, and does nothing more', async () => {
    const { root, remote } = setup();
    commit(root, 'c.txt', 'feat: three');
    expect(await pushBranch(root, 'origin', 10_000)).toEqual({ ok: true });
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
  });

  it('reports a plain failure, without a divergence, when the remote is unreachable', async () => {
    const { root } = setup();
    const result = await pushBranch(root, 'nowhere', 10_000, { force: true });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('diverged');
  });

  it('reports the commits a diverged push would overwrite, and leaves the remote alone', async () => {
    const { root, remote } = setup();
    // The agent amends a pushed commit, and someone else pushed one meanwhile.
    git(root, 'commit', '-q', '--amend', '-m', 'feat: two, reworded');
    const theirs = pushElsewhere(remote, 'fix: theirs');

    const result = await pushBranch(root, 'origin', 10_000);
    expect(result.ok).toBe(false);
    if (result.ok || !result.diverged) throw new Error('expected a divergence');
    const { diverged } = result;
    expect(diverged).toMatchObject({ remote: 'origin', branch: 'main', localSha: git(root, 'rev-parse', 'HEAD'), remoteSha: theirs });
    expect(diverged.commits.map(({ subject, equivalent }) => [subject, equivalent])).toEqual([
      ['feat: two', true],
      ['fix: theirs', false],
    ]);
    expect(git(remote, 'rev-parse', 'main')).toBe(theirs);

    const lines = describeDivergence(diverged).join('\n');
    expect(lines).toContain('origin/main');
    expect(lines).toContain('fix: theirs (not in the local branch)');
    expect(lines).toContain('git.forcePush');
  });

  it('force-pushes over diverged history once its old tip is kept here and on the remote', async () => {
    const { root, remote } = setup();
    git(root, 'commit', '-q', '--amend', '-m', 'feat: two, reworded');
    const theirs = pushElsewhere(remote, 'fix: theirs');

    const result = await pushBranch(root, 'origin', 10_000, { force: true, now });
    if (!result.ok || !result.overwritten) throw new Error(`expected an overwrite: ${JSON.stringify(result)}`);
    const { overwritten } = result;
    expect(overwritten).toMatchObject({
      branch: 'main',
      remoteSha: theirs,
      localRef: 'refs/ralph/overwritten/main/20261008T233000Z',
      backupBranch: 'ralph/overwritten/main-20261008T233000Z',
    });
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(remote, 'rev-parse', 'ralph/overwritten/main-20261008T233000Z')).toBe(theirs);
    expect(git(root, 'rev-parse', 'refs/ralph/overwritten/main/20261008T233000Z')).toBe(theirs);

    const lines = describeOverwrite(overwritten).join('\n');
    expect(lines).toContain('fix: theirs (NOT in the new history)');
    expect(lines).toContain('feat: two (kept: an equivalent patch is in the new history)');
    expect(lines).toContain(`git fetch origin ralph/overwritten/main-20261008T233000Z && git cherry-pick <sha>`);
  });

  it('does not force when the backup cannot be pushed', async () => {
    const { root, remote } = setup();
    git(root, 'commit', '-q', '--amend', '-m', 'feat: two, reworded');
    const theirs = pushElsewhere(remote, 'fix: theirs');
    const hook = resolve(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/ralph/*) echo "no backups here" >&2; exit 1;; esac; done\n');
    chmodSync(hook, 0o755);

    const result = await pushBranch(root, 'origin', 10_000, { force: true, now });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('could not back up origin/main before forcing');
    expect(result.diverged?.remoteSha).toBe(theirs);
    expect(git(remote, 'rev-parse', 'main')).toBe(theirs);
  });
});
