import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySplit, describeIds, readProposal, splitDir, SplitError } from '../src/loop/split.js';
import { TaskStore } from '../src/tasks/store.js';

const spec = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, title: `Title of ${id}`, acceptanceCriteria: [`${id} works`], ...extra }, null, 2);

/** A git project with a committed plan: TASK-1, TASK-2 (with a spec and a handoff), TASK-3. */
function project(options: { wrapper?: boolean } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-split-'));
  mkdirSync(resolve(root, '.ralph', 'tasks'), { recursive: true });
  mkdirSync(resolve(root, '.ralph', 'handoff'), { recursive: true });
  const tasks = ['TASK-1', 'TASK-2', 'TASK-3'].map((id) => ({
    id,
    title: `Title of ${id}`,
    category: 'core',
    specFilePath: `.ralph/tasks/${id}.json`,
    passes: id === 'TASK-1',
    ...(id === 'TASK-3' ? { priority: 'low' } : {}),
  }));
  writeFileSync(
    resolve(root, '.ralph', 'tasks.json'),
    JSON.stringify(options.wrapper ? { version: 1, tasks } : tasks, null, 2),
  );
  for (const task of tasks) writeFileSync(resolve(root, task.specFilePath), spec(task.id));
  writeFileSync(resolve(root, '.ralph', 'handoff', 'TASK-2.md'), '## Status\n\nHalfway.');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'plan'], { cwd: root });
  return root;
}

function propose(root: string, proposal: Record<string, unknown>, specs: Record<string, string> = {}): void {
  const dir = resolve(root, splitDir('.ralph', 'TASK-2'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'proposal.json'), JSON.stringify(proposal));
  for (const [id, text] of Object.entries(specs)) writeFileSync(resolve(dir, `${id}.json`), text);
}

const good = {
  task: 'TASK-2',
  splittable: true,
  reason: 'Parser first, then the printer.',
  tasks: [
    { id: 'TASK-2.1', title: 'Parse' },
    { id: 'TASK-2.2', title: 'Print', category: 'output' },
  ],
};
const goodSpecs = { 'TASK-2.1': spec('TASK-2.1'), 'TASK-2.2': spec('TASK-2.2') };

const tasksOf = (root: string) => TaskStore.forProject(root, '.ralph').readTasks();

describe('readProposal', () => {
  it('reports a missing proposal', () => {
    const root = project();
    expect(readProposal(root, '.ralph', 'TASK-2', tasksOf(root))).toEqual({ status: 'missing' });
  });

  it('accepts a split with a spec for every new task', () => {
    const root = project();
    propose(root, good, goodSpecs);
    const read = readProposal(root, '.ralph', 'TASK-2', tasksOf(root));
    expect(read).toMatchObject({ status: 'ok', proposal: { splittable: true, tasks: [{ id: 'TASK-2.1' }, { id: 'TASK-2.2' }] } });
  });

  it('accepts advice not to split, with a reason', () => {
    const root = project();
    propose(root, { task: 'TASK-2', splittable: false, reason: 'npm test hangs on the watcher' });
    expect(readProposal(root, '.ralph', 'TASK-2', tasksOf(root))).toMatchObject({
      status: 'ok',
      proposal: { splittable: false, reason: 'npm test hangs on the watcher' },
    });
  });

  it('lists what the agent must fix', () => {
    const root = project();
    propose(
      root,
      { task: 'TASK-2', splittable: true, reason: '', tasks: [{ id: 'TASK-2.1', title: '' }, { id: 'TASK-2.3', title: 'Skip' }] },
      { 'TASK-2.1': spec('TASK-2.1', { acceptanceCriteria: [] }) },
    );
    const read = readProposal(root, '.ralph', 'TASK-2', tasksOf(root));
    expect(read.status).toBe('invalid');
    const problems = read.status === 'invalid' ? read.problems.join('\n') : '';
    expect(problems).toContain('task TASK-2.1: title is empty');
    expect(problems).toContain('needs a non-empty acceptanceCriteria');
    expect(problems).toContain('has id "TASK-2.3", expected "TASK-2.2"');
  });

  it('wants at least two tasks, and a reason to decline', () => {
    const root = project();
    propose(root, { ...good, tasks: [good.tasks[0]] }, goodSpecs);
    const one = readProposal(root, '.ralph', 'TASK-2', tasksOf(root));
    expect(one.status === 'invalid' && one.problems.join()).toContain('at least two tasks');

    propose(root, { task: 'TASK-2', splittable: false, reason: ' ' });
    const declined = readProposal(root, '.ralph', 'TASK-2', tasksOf(root));
    expect(declined.status === 'invalid' && declined.problems.join()).toContain('needs a reason');
  });

  it('rejects ids that already exist and specs for another task', () => {
    const root = project();
    const file = resolve(root, '.ralph', 'tasks.json');
    const tasks = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    writeFileSync(file, JSON.stringify([...tasks, { id: 'TASK-2.1', title: 'Old', passes: false }]));
    propose(root, good, { ...goodSpecs, 'TASK-2.2': spec('TASK-9') });
    const read = readProposal(root, '.ralph', 'TASK-2', tasksOf(root));
    const problems = read.status === 'invalid' ? read.problems.join('\n') : '';
    expect(problems).toContain('TASK-2.1 already exists in tasks.json');
    expect(problems).toContain('has id "TASK-9", expected "TASK-2.2"');
  });

  it('reports a proposal that is not JSON or not the right shape', () => {
    const root = project();
    propose(root, { task: 'TASK-2' });
    expect(readProposal(root, '.ralph', 'TASK-2', tasksOf(root)).status).toBe('invalid');
    writeFileSync(resolve(root, splitDir('.ralph', 'TASK-2'), 'proposal.json'), '{');
    const read = readProposal(root, '.ralph', 'TASK-2', tasksOf(root));
    expect(read.status === 'invalid' && read.problems[0]).toContain('is not valid JSON');
  });
});

describe('applySplit', () => {
  it('puts the new tasks in place of the old one, and archives it with its handoff', async () => {
    const root = project();
    propose(root, good, goodSpecs);

    const applied = await applySplit({ projectRoot: root, ralphDir: '.ralph', taskId: 'TASK-2', commit: true });

    expect(applied).toMatchObject({ committed: true });
    expect(tasksOf(root).map((task) => task.id)).toEqual(['TASK-1', 'TASK-2.1', 'TASK-2.2', 'TASK-3']);
    expect(tasksOf(root)[1]).toEqual({
      id: 'TASK-2.1',
      title: 'Parse',
      category: 'core',
      specFilePath: '.ralph/tasks/TASK-2.1.json',
      passes: false,
      splitFrom: 'TASK-2',
      splitDepth: 1,
    });
    expect(tasksOf(root)[2]).toMatchObject({ category: 'output' });
    // Fields Ralph does not know about survive.
    expect(tasksOf(root)[3]).toMatchObject({ priority: 'low' });

    const dir = resolve(root, '.ralph', 'split', 'TASK-2');
    expect(existsSync(resolve(root, '.ralph', 'tasks', 'TASK-2.1.json'))).toBe(true);
    expect(existsSync(resolve(dir, 'TASK-2.1.json'))).toBe(false);
    expect(existsSync(resolve(root, '.ralph', 'tasks', 'TASK-2.json'))).toBe(false);
    expect(JSON.parse(readFileSync(resolve(dir, 'TASK-2.json'), 'utf8'))).toMatchObject({ id: 'TASK-2' });
    expect(existsSync(resolve(root, '.ralph', 'handoff', 'TASK-2.md'))).toBe(false);
    expect(readFileSync(resolve(dir, 'handoff.md'), 'utf8')).toContain('Halfway.');
    expect(JSON.parse(readFileSync(resolve(dir, 'proposal.json'), 'utf8'))).toHaveProperty('appliedAt');

    const log = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: root, encoding: 'utf8' });
    expect(log).toContain('chore(plan): split TASK-2 into TASK-2.1 and TASK-2.2');
    expect(log).toContain('Parser first, then the printer.');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
  });

  it('keeps a wrapped task list wrapped', async () => {
    const root = project({ wrapper: true });
    propose(root, good, goodSpecs);
    await applySplit({ projectRoot: root, ralphDir: '.ralph', taskId: 'TASK-2', commit: false });
    const raw = JSON.parse(readFileSync(resolve(root, '.ralph', 'tasks.json'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.tasks.map((task: { id: string }) => task.id)).toEqual(['TASK-1', 'TASK-2.1', 'TASK-2.2', 'TASK-3']);
  });

  it('commits only the split, even when the handoff was never committed', async () => {
    const root = project();
    execFileSync('git', ['rm', '-q', '--cached', '.ralph/handoff/TASK-2.md'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'untrack handoff'], { cwd: root });
    writeFileSync(resolve(root, 'unrelated.txt'), 'not mine');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: root });
    propose(root, good, goodSpecs);

    const applied = await applySplit({ projectRoot: root, ralphDir: '.ralph', taskId: 'TASK-2', commit: true });

    expect(applied.commitError).toBeUndefined();
    const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' });
    expect(files).toContain('.ralph/split/TASK-2/handoff.md');
    expect(files).not.toContain('unrelated.txt');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()).toBe('A  unrelated.txt');
  });

  it('counts depth from the task it splits', async () => {
    const root = project();
    const file = resolve(root, '.ralph', 'tasks.json');
    const tasks = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    tasks[1] = { ...tasks[1], splitFrom: 'TASK-0', splitDepth: 1 };
    writeFileSync(file, JSON.stringify(tasks));
    propose(root, good, goodSpecs);
    const { children } = await applySplit({ projectRoot: root, ralphDir: '.ralph', taskId: 'TASK-2', commit: false });
    expect(children.map((child) => child.splitDepth)).toEqual([2, 2]);
  });

  it('refuses a missing, invalid or declined proposal, and a task that passes', async () => {
    const root = project();
    const apply = (taskId = 'TASK-2') => applySplit({ projectRoot: root, ralphDir: '.ralph', taskId, commit: false });
    await expect(apply()).rejects.toThrow(/proposal.json does not exist/);
    propose(root, good, {});
    await expect(apply()).rejects.toThrow(/has problems/);
    propose(root, { task: 'TASK-2', splittable: false, reason: 'it hangs' });
    await expect(apply()).rejects.toThrow(/advises against splitting TASK-2: it hangs/);
    await expect(apply('TASK-1')).rejects.toThrow(SplitError);
    await expect(apply('TASK-7')).rejects.toThrow(/not in tasks.json/);
    expect(tasksOf(root).map((task) => task.id)).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);
  });
});

describe('describeIds', () => {
  it('names two tasks, or a range', () => {
    expect(describeIds(['TASK-1.1', 'TASK-1.2'])).toBe('TASK-1.1 and TASK-1.2');
    expect(describeIds(['TASK-1.1', 'TASK-1.2', 'TASK-1.3'])).toBe('TASK-1.1–TASK-1.3');
  });
});
