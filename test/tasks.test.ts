import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareIds, TaskStore, TaskStoreError } from '../src/tasks/store.js';

function storeWith(content: string, specs: Record<string, unknown> = {}): TaskStore {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-tasks-'));
  mkdirSync(resolve(root, '.ralph/tasks'), { recursive: true });
  const file = resolve(root, '.ralph/tasks.json');
  writeFileSync(file, content);
  for (const [path, body] of Object.entries(specs)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return new TaskStore(file);
}

const specOf = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Spec ${id}`, acceptanceCriteria: ['works'], ...extra });

const TASKS = JSON.stringify([
  { id: 'TASK-1', title: 'first', passes: true },
  { id: 'TASK-2', title: 'second', passes: false },
  { id: 'TASK-3', title: 'third', passes: false },
]);

describe('TaskStore', () => {
  it('counts passing tasks and picks the first outstanding one', () => {
    const summary = storeWith(TASKS).reload();
    expect(summary.total).toBe(3);
    expect(summary.passedCount).toBe(1);
    expect(summary.next?.id).toBe('TASK-2');
  });

  it('reports no next task when everything passes', () => {
    const summary = storeWith(
      JSON.stringify([{ id: 'TASK-1', passes: true }]),
    ).reload();
    expect(summary.next).toBeUndefined();
  });

  it('accepts a { tasks: [...] } wrapper as well as a bare array', () => {
    const summary = storeWith(JSON.stringify({ tasks: [{ id: 'TASK-9', passes: false }] })).reload();
    expect(summary.next?.id).toBe('TASK-9');
  });

  it('treats a missing passes flag as not passing', () => {
    const summary = storeWith(JSON.stringify([{ id: 'TASK-1', title: 'x' }])).reload();
    expect(summary.next?.id).toBe('TASK-1');
  });

  it('verifies a claimed task against the file', () => {
    const store = storeWith(TASKS);
    expect(store.isPassing('TASK-1')).toBe(true);
    expect(store.isPassing('TASK-2')).toBe(false);
  });

  it('sets one task\'s passes flag, keeping the wrapper and fields it does not know', () => {
    const store = storeWith(JSON.stringify({ project: 'shop', tasks: [{ id: 'TASK-1', passes: true, owner: 'me' }, { id: 'TASK-2' }] }));
    expect(store.setPasses('TASK-1', false)).toBe(true);
    expect(store.setPasses('TASK-9', true)).toBe(false);
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual({
      project: 'shop',
      tasks: [{ id: 'TASK-1', passes: false, owner: 'me' }, { id: 'TASK-2' }],
    });

    const bare = storeWith(TASKS);
    bare.setPasses('TASK-2', true);
    expect(bare.reload().passedCount).toBe(2);
    expect(Array.isArray(JSON.parse(readFileSync(bare.path, 'utf8')))).toBe(true);
  });

  it('fails loudly on malformed task files', () => {
    expect(() => storeWith('{oops').reload()).toThrow(TaskStoreError);
    expect(() => storeWith(JSON.stringify([{ title: 'no id' }])).reload()).toThrow(TaskStoreError);
  });

  it('reads a task from its spec, and only its status and place from the list', () => {
    const store = storeWith(JSON.stringify([{ id: 'TASK-2', passes: true }, { id: 'TASK-1', passes: false }]), {
      '.ralph/tasks/TASK-1.json': specOf('TASK-1', { category: 'setup' }),
      '.ralph/tasks/TASK-2.json': specOf('TASK-2', { splitFrom: 'TASK-0', splitDepth: 1 }),
    });
    expect(store.readTasks()).toEqual([
      { id: 'TASK-2', title: 'Spec TASK-2', passes: true, specFilePath: '.ralph/tasks/TASK-2.json', splitFrom: 'TASK-0', splitDepth: 1 },
      { id: 'TASK-1', title: 'Spec TASK-1', passes: false, specFilePath: '.ralph/tasks/TASK-1.json', category: 'setup' },
    ]);
  });

  it('prefers the spec to what an older, fuller list says, and still follows its spec paths', () => {
    const store = storeWith(
      JSON.stringify({
        tasks: [
          { id: 'TASK-1', title: 'Stale title', category: 'old', specFilePath: '.ralph/tasks/TASK-1.json', passes: true, owner: 'me' },
          { id: 'TASK-2', title: 'Elsewhere', specFilePath: 'specs/two.json', passes: false },
        ],
      }),
      { '.ralph/tasks/TASK-1.json': specOf('TASK-1'), 'specs/two.json': { id: 'TASK-2', acceptanceCriteria: ['works'] } },
    );
    expect(store.readTasks()).toEqual([
      { id: 'TASK-1', title: 'Spec TASK-1', category: 'old', specFilePath: '.ralph/tasks/TASK-1.json', passes: true, owner: 'me' },
      { id: 'TASK-2', title: 'Elsewhere', specFilePath: 'specs/two.json', passes: false },
    ]);
  });

  it('runs specs the list leaves out after the listed tasks, in id order', () => {
    const store = storeWith(JSON.stringify([{ id: 'TASK-3', passes: true }]), {
      '.ralph/tasks/TASK-3.json': specOf('TASK-3'),
      '.ralph/tasks/TASK-10.json': specOf('TASK-10'),
      '.ralph/tasks/TASK-2.1.json': specOf('TASK-2.1'),
      '.ralph/tasks/TASK-2.json': specOf('TASK-2'),
      '.ralph/tasks/notes.json': {},
    });
    const inspection = store.inspect();
    expect(inspection.tasks.map((task) => task.id)).toEqual(['TASK-3', 'TASK-2', 'TASK-2.1', 'TASK-10']);
    expect(inspection.unlisted).toEqual(['TASK-2', 'TASK-2.1', 'TASK-10']);
    expect(store.reload()).toMatchObject({ total: 4, passedCount: 1, next: { id: 'TASK-2', title: 'Spec TASK-2', passes: false } });
  });

  it('reports entries without a spec and specs with the wrong id', () => {
    const store = storeWith(JSON.stringify([{ id: 'TASK-1', title: 'Listed only', passes: true }, { id: 'TASK-2' }, { id: 'TASK-3' }]), {
      '.ralph/tasks/TASK-3.json': specOf('TASK-9'),
    });
    const inspection = store.inspect();
    expect(inspection.missingSpec).toEqual([
      { id: 'TASK-1', passes: true },
      { id: 'TASK-2', passes: false },
    ]);
    expect(inspection.idMismatch).toEqual([{ id: 'TASK-3', specId: 'TASK-9' }]);
    expect(inspection.tasks[0]).toMatchObject({ id: 'TASK-1', title: 'Listed only' });
  });

  it('never runs the spec of a task that was split', () => {
    const store = storeWith(JSON.stringify([{ id: 'TASK-1.1' }, { id: 'TASK-1.2' }]), {
      '.ralph/tasks/TASK-1.json': specOf('TASK-1'),
      '.ralph/tasks/TASK-1.1.json': specOf('TASK-1.1'),
      '.ralph/tasks/TASK-1.2.json': specOf('TASK-1.2'),
      '.ralph/split/TASK-1/proposal.json': {
        task: 'TASK-1',
        splittable: true,
        tasks: [{ id: 'TASK-1.1', title: 'a' }, { id: 'TASK-1.2', title: 'b' }],
        appliedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    const inspection = store.inspect();
    expect(inspection.tasks.map((task) => task.id)).toEqual(['TASK-1.1', 'TASK-1.2']);
    expect(inspection.leftBehind).toEqual(['TASK-1']);
    expect(inspection.unlisted).toEqual([]);
  });

  it('lists a task the list left out when its status is set', () => {
    const store = storeWith(JSON.stringify([{ id: 'TASK-1', passes: true }]), {
      '.ralph/tasks/TASK-1.json': specOf('TASK-1'),
      '.ralph/tasks/TASK-2.json': specOf('TASK-2'),
    });
    expect(store.setPasses('TASK-2', true)).toBe(true);
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual([
      { id: 'TASK-1', passes: true },
      { id: 'TASK-2', passes: true },
    ]);
    expect(store.inspect().unlisted).toEqual([]);
  });

  it('orders ids naturally', () => {
    expect(['TASK-10', 'TASK-7.1', 'TASK-7', 'TASK-2', 'TASK-7.10', 'TASK-7.2'].sort(compareIds)).toEqual([
      'TASK-2',
      'TASK-7',
      'TASK-7.1',
      'TASK-7.2',
      'TASK-7.10',
      'TASK-10',
    ]);
  });
});
