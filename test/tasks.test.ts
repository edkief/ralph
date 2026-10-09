import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore, TaskStoreError } from '../src/tasks/store.js';

function storeWith(content: string): TaskStore {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-tasks-'));
  mkdirSync(resolve(root, '.ralph'), { recursive: true });
  const file = resolve(root, '.ralph/tasks.json');
  writeFileSync(file, content);
  return new TaskStore(file);
}

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
});
