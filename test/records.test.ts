import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitRecords, recordPaths } from '../src/loop/records.js';
import { respond } from '../src/human/respond.js';
import { writePending } from '../src/human/request.js';
import { artifactsCheck, uncommittedCheck, upstreamCheck } from '../src/opencode/preflight.js';
import { ConfigSchema } from '../src/config/schema.js';

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** A committed project with a Ralph folder whose history/ is ignored. */
function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-records-'));
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

describe('commitRecords', () => {
  it('names the records under the Ralph folder', () => {
    expect(recordPaths('.ralph/')).toEqual([
      '.ralph/decisions.jsonl',
      '.ralph/handoff',
      '.ralph/assess',
      '.ralph/split',
      '.ralph/journal',
      '.ralph/artifacts',
    ]);
  });

  it('commits the records alone, leaving other changes and history out', async () => {
    const root = project();
    mkdirSync(resolve(root, '.ralph', 'handoff'));
    writeFileSync(resolve(root, '.ralph', 'handoff', 'TASK-1.md'), '# Handoff');
    mkdirSync(resolve(root, '.ralph', 'artifacts', 'TASK-1'), { recursive: true });
    writeFileSync(resolve(root, '.ralph', 'artifacts', 'TASK-1', 'home.png'), 'png');
    writeFileSync(resolve(root, '.ralph', 'history', 'stop.json'), '{}');
    writeFileSync(resolve(root, '.ralph', 'tasks.json'), JSON.stringify([{ id: 'TASK-1', passes: true }]));
    // Staged by the agent: stays staged, outside the commit.
    writeFileSync(resolve(root, 'app.ts'), 'work');
    git(root, 'add', 'app.ts');

    const result = await commitRecords({ projectRoot: root, ralphDir: '.ralph', subject: 'chore(ralph): record' });

    expect(result).toMatchObject({ committed: true });
    expect(result.files.sort()).toEqual(['.ralph/artifacts/TASK-1/home.png', '.ralph/handoff/TASK-1.md']);
    expect(git(root, 'show', '--name-only', '--format=%s', 'HEAD').split('\n')).toEqual([
      'chore(ralph): record',
      '',
      '.ralph/artifacts/TASK-1/home.png',
      '.ralph/handoff/TASK-1.md',
    ]);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('app.ts');
    expect(git(root, 'diff', '--name-only')).toBe('.ralph/tasks.json');
  });

  it('commits past a record folder git has never tracked anything in', async () => {
    const root = project();
    // As a split leaves it, having moved the task's handoff out.
    mkdirSync(resolve(root, '.ralph', 'handoff'));
    mkdirSync(resolve(root, '.ralph', 'journal', 'run'), { recursive: true });
    writeFileSync(resolve(root, '.ralph', 'journal', 'run', 'run.json'), '{}');

    const result = await commitRecords({ projectRoot: root, ralphDir: '.ralph', subject: 'chore(ralph): record' });

    expect(result).toEqual({ committed: true, files: ['.ralph/journal/run/run.json'] });
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('.ralph/journal/run/run.json');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('commits a deleted record, and a moved one under both its names', async () => {
    const root = project();
    mkdirSync(resolve(root, '.ralph', 'handoff'));
    writeFileSync(resolve(root, '.ralph', 'handoff', 'TASK-1.md'), '# Handoff');
    mkdirSync(resolve(root, '.ralph', 'assess'));
    writeFileSync(resolve(root, '.ralph', 'assess', 'TASK-1.json'), '{}');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'records');
    rmSync(resolve(root, '.ralph', 'assess', 'TASK-1.json'));
    mkdirSync(resolve(root, '.ralph', 'split', 'TASK-1'), { recursive: true });
    renameSync(resolve(root, '.ralph', 'handoff', 'TASK-1.md'), resolve(root, '.ralph', 'split', 'TASK-1', 'handoff.md'));

    const result = await commitRecords({ projectRoot: root, ralphDir: '.ralph', subject: 'chore(ralph): record' });

    expect(result).toMatchObject({ committed: true });
    expect(git(root, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'A\t.ralph/split/TASK-1/handoff.md',
      'D\t.ralph/assess/TASK-1.json',
      'D\t.ralph/handoff/TASK-1.md',
    ]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('leaves nothing staged when the commit fails', async () => {
    const root = project();
    writeFileSync(resolve(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(resolve(root, '.ralph', 'decisions.jsonl'), '{}\n');

    const result = await commitRecords({ projectRoot: root, ralphDir: '.ralph', subject: 'chore(ralph): record' });

    expect(result).toEqual({ committed: false, files: ['.ralph/decisions.jsonl'], error: 'hook says no' });
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe('?? .ralph/decisions.jsonl');
  });

  it('does nothing when the records are unchanged, or outside a repository', async () => {
    const root = project();
    expect(await commitRecords({ projectRoot: root, ralphDir: '.ralph', subject: 's' })).toEqual({ committed: false, files: [] });
    const bare = mkdtempSync(resolve(tmpdir(), 'ralph-records-'));
    writeFileSync(resolve(bare, 'decisions.jsonl'), '{}');
    expect(await commitRecords({ projectRoot: bare, ralphDir: '.', subject: 's' })).toEqual({ committed: false, files: [] });
  });
});

describe('answering with no loop waiting', () => {
  const ask = (root: string) =>
    writePending(resolve(root, '.ralph'), {
      id: 'run-1',
      runId: 'run',
      kind: 'decide',
      taskId: 'TASK-1',
      message: 'REST or GraphQL?',
      question: 'REST or GraphQL?',
      waiting: false,
      createdAt: '2026-10-01T00:00:00.000Z',
    });

  it('commits the decision', async () => {
    const root = project();
    ask(root);
    await respond({ projectRoot: root, ralphDir: '.ralph', input: { id: 'run-1', action: 'answer', text: 'REST' }, by: 'cli' });

    expect(git(root, 'log', '-1', '--format=%s')).toBe('chore(ralph): record answer on decide');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('.ralph/decisions.jsonl');
  });

  it('commits nothing with git.records "never"', async () => {
    const root = project();
    ask(root);
    await respond({
      projectRoot: root,
      ralphDir: '.ralph',
      input: { id: 'run-1', action: 'answer', text: 'REST' },
      by: 'cli',
      records: 'never',
    });

    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});

describe('doctor', () => {
  const config = (root: string) => ConfigSchema.parse({ projectRoot: root });

  it('warns about uncommitted files in the Ralph folder, but not its history', async () => {
    const root = project();
    writeFileSync(resolve(root, '.ralph', 'history', 'state.json'), '{}');
    expect(await uncommittedCheck(config(root))).toBeUndefined();

    writeFileSync(resolve(root, '.ralph', 'decisions.jsonl'), '{}\n');
    expect(await uncommittedCheck(config(root))).toMatchObject({ name: 'records', ok: false, fatal: false });
    expect((await uncommittedCheck(config(root)))?.detail).toContain('.ralph/decisions.jsonl');
  });

  it('warns about commits not pushed, and a branch with no upstream', async () => {
    const remote = mkdtempSync(resolve(tmpdir(), 'ralph-remote-'));
    git(remote, 'init', '-q', '--bare');
    const root = project();
    expect(await upstreamCheck(config(root))).toBeUndefined();

    git(root, 'remote', 'add', 'origin', remote);
    expect((await upstreamCheck(config(root)))?.detail).toMatch(/has no upstream branch/);

    git(root, 'push', '-q', '-u', 'origin', 'HEAD');
    expect(await upstreamCheck(config(root))).toBeUndefined();

    git(root, 'commit', '-q', '--allow-empty', '-m', 'more');
    expect(await upstreamCheck(config(root))).toMatchObject({ name: 'upstream', ok: false, fatal: false });
    expect((await upstreamCheck(config(root)))?.detail).toMatch(/^1 commit not pushed/);
  });

  it('warns when the kept artifacts grow large', () => {
    const root = project();
    expect(artifactsCheck(config(root), 10)).toBeUndefined();
    mkdirSync(resolve(root, '.ralph', 'artifacts', 'TASK-1'), { recursive: true });
    writeFileSync(resolve(root, '.ralph', 'artifacts', 'TASK-1', 'a.png'), '123456');
    expect(artifactsCheck(config(root), 10)).toBeUndefined();
    writeFileSync(resolve(root, '.ralph', 'artifacts', 'TASK-1', 'b.png'), '123456');
    expect(artifactsCheck(config(root), 10)).toMatchObject({ name: 'artifacts', ok: false, fatal: false });
    expect(artifactsCheck(config(root), 10)?.detail).toMatch(/Git LFS/);
  });
});
