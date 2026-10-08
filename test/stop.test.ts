import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStop } from '../src/human/stop.js';
import { readStopRequest } from '../src/human/request.js';
import { ConfigSchema } from '../src/config/schema.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-stop-'));
  mkdirSync(resolve(root, '.ralph', 'history'), { recursive: true });
  writeFileSync(resolve(root, '.ralph', 'tasks.json'), JSON.stringify([{ id: 'TASK-1', passes: false }]));
  writeFileSync(resolve(root, '.gitignore'), '.ralph/history/\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function stop(root: string, mode: 'after-iteration' | 'now' | 'park', git: Record<string, unknown> = {}) {
  let said = '';
  const config = ConfigSchema.parse({ projectRoot: root, git });
  return runStop({ config, mode, output: { write: (text: string) => (said += text) } }).then((code) => ({ code, said }));
}

describe('ralph stop', () => {
  it('asks a live run to stop, or to park', async () => {
    const root = project();
    const dir = resolve(root, '.ralph', 'history', '20261003-101500-abcd');
    mkdirSync(dir);
    writeFileSync(
      resolve(dir, 'state.json'),
      JSON.stringify({ runId: '20261003-101500-abcd', status: 'running', pid: process.pid, hostname: hostname(), startedAt: 't', updatedAt: 't', iteration: 1 }),
    );

    expect(await stop(root, 'park')).toEqual({ code: 0, said: 'Ralph parks: the agent hands off, then the work is committed and pushed.\n' });
    expect(readStopRequest(resolve(root, '.ralph'))).toEqual({ mode: 'park' });
  });

  it('says there is nothing to stop', async () => {
    const root = project();
    expect(await stop(root, 'after-iteration')).toEqual({ code: 4, said: 'Nothing is running to stop.\n' });
    expect(readStopRequest(resolve(root, '.ralph'))).toBeUndefined();
  });

  it('with nothing running, parks by committing the records and pushing', async () => {
    const root = project();
    const remote = mkdtempSync(resolve(tmpdir(), 'ralph-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    writeFileSync(resolve(root, '.ralph', 'decisions.jsonl'), '{}\n');
    writeFileSync(resolve(root, 'draft.ts'), 'mine');

    const { code, said } = await stop(root, 'park');

    expect(code).toBe(0);
    expect(said).toContain("Committed Ralph's records (1 file).");
    expect(git(root, 'log', '-1', '--format=%s')).toBe('chore(ralph): record, parked');
    expect(git(remote, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'status', '--porcelain')).toBe('?? draft.ts');
  });

  it('with nothing running, stops at a remote branch that has diverged, or overwrites it with a backup', async () => {
    const root = project();
    const remote = mkdtempSync(resolve(tmpdir(), 'ralph-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', 'origin', 'HEAD');
    // History rewritten after the push.
    git(root, 'commit', '-q', '--amend', '-m', 'init, reworded');
    const pushed = git(remote, 'rev-parse', 'HEAD');

    const rejected = await stop(root, 'park');
    expect(rejected.code).toBe(7);
    expect(rejected.said).toContain('has 1 commit the local branch');
    expect(git(remote, 'rev-parse', 'HEAD')).toBe(pushed);

    const forced = await stop(root, 'park', { forcePush: true });
    expect(forced.code).toBe(0);
    expect(forced.said).toContain('Force-pushed');
    expect(forced.said).toContain('init (kept: an equivalent patch is in the new history)');
    expect(git(remote, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'HEAD'));
  });

  it('reports a push that fails', async () => {
    const root = project();
    const { code, said } = await stop(root, 'park');
    expect(code).toBe(4);
    expect(said).toMatch(/Could not push to origin/);
  });
});
