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

function stop(root: string, mode: 'after-iteration' | 'now' | 'park') {
  let said = '';
  const config = ConfigSchema.parse({ projectRoot: root });
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

  it('reports a push that fails', async () => {
    const root = project();
    const { code, said } = await stop(root, 'park');
    expect(code).toBe(4);
    expect(said).toMatch(/Could not push to origin/);
  });
});
