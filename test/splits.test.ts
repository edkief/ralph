import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitRecords, splitLineage, type SplitRecord } from '../src/tasks/splits.js';

function project(files: Record<string, unknown>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-splits-'));
  for (const [path, content] of Object.entries(files)) {
    const file = resolve(root, path);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const applied = (task: string, children: string[], extra: Record<string, unknown> = {}) => ({
  task,
  splittable: true,
  reason: 'smaller',
  tasks: children.map((id) => ({ id, title: `Title of ${id}` })),
  appliedAt: '2026-10-01T10:00:00.000Z',
  ...extra,
});

describe('readSplitRecords', () => {
  it('reads the split task from its record', () => {
    const root = project({
      '.ralph/split/T-1/proposal.json': applied('T-1', ['T-1.1', 'T-1.2'], {
        parent: { title: 'One', specFilePath: '.ralph/split/T-1/T-1.json', handoffPath: '.ralph/split/T-1/handoff.md' },
      }),
    });
    expect(readSplitRecords(root, '.ralph')).toEqual([
      {
        taskId: 'T-1',
        title: 'One',
        specFilePath: '.ralph/split/T-1/T-1.json',
        handoffPath: '.ralph/split/T-1/handoff.md',
        children: [
          { id: 'T-1.1', title: 'Title of T-1.1' },
          { id: 'T-1.2', title: 'Title of T-1.2' },
        ],
        appliedAt: '2026-10-01T10:00:00.000Z',
      },
    ]);
  });

  it('works out an older record from the archived spec and handoff', () => {
    const root = project({
      '.ralph/split/T-1/proposal.json': applied('T-1', ['T-1.1', 'T-1.2']),
      '.ralph/split/T-1/T-1.json': { id: 'T-1', title: 'One, from its spec' },
      '.ralph/split/T-1/handoff.md': 'Halfway.',
      '.ralph/split/T-2/proposal.json': applied('T-2', ['T-2.1', 'T-2.2']),
    });
    const records = readSplitRecords(root, '.ralph').sort((a, b) => a.taskId.localeCompare(b.taskId));
    expect(records[0]).toMatchObject({
      title: 'One, from its spec',
      specFilePath: '.ralph/split/T-1/T-1.json',
      handoffPath: '.ralph/split/T-1/handoff.md',
    });
    expect(records[1]).toMatchObject({ taskId: 'T-2', title: null });
    expect(records[1]).not.toHaveProperty('specFilePath');
    expect(records[1]).not.toHaveProperty('handoffPath');
  });

  it('leaves out proposals not applied, advice against splitting, and files that do not read', () => {
    const root = project({
      '.ralph/split/T-1/proposal.json': { ...applied('T-1', ['T-1.1', 'T-1.2']), appliedAt: undefined },
      '.ralph/split/T-2/proposal.json': { task: 'T-2', splittable: false, reason: 'hangs', appliedAt: '2026-10-01' },
      '.ralph/split/T-3/proposal.json': '{',
      '.ralph/split/T-4/proposal.json': applied('T-5', ['T-5.1', 'T-5.2']),
      '.ralph/split/T-6/notes.md': 'no proposal',
    });
    expect(readSplitRecords(root, '.ralph')).toEqual([]);
    expect(readSplitRecords(project({}), '.ralph')).toEqual([]);
  });
});

describe('splitLineage', () => {
  const record = (taskId: string, children: string[], title: string | null = `Title of ${taskId}`): SplitRecord => ({
    taskId,
    title,
    children: children.map((id) => ({ id, title: `Planned ${id}` })),
    appliedAt: '2026-10-01T10:00:00.000Z',
  });

  it('names the task split, and how far the tasks it was split into have got', () => {
    const tasks = [
      { id: 'T-1.1', title: 'First half', passes: true, splitFrom: 'T-1' },
      { id: 'T-1.2', title: 'Second half', passes: false, splitFrom: 'T-1' },
    ];
    expect(splitLineage([record('T-1', ['T-1.1', 'T-1.2'])], tasks, 'T-1.2')).toEqual([
      {
        id: 'T-1',
        title: 'Title of T-1',
        children: [
          { id: 'T-1.1', title: 'First half', passes: true },
          { id: 'T-1.2', title: 'Second half', passes: false },
        ],
      },
    ]);
  });

  it('follows a task split twice, through the one gone from tasks.json', () => {
    const tasks = [
      { id: 'T-1.1.1', title: 'a', passes: false, splitFrom: 'T-1.1' },
      { id: 'T-1.1.2', title: 'b', passes: false, splitFrom: 'T-1.1' },
      { id: 'T-1.2', title: 'c', passes: false, splitFrom: 'T-1' },
    ];
    const records = [record('T-1', ['T-1.1', 'T-1.2']), record('T-1.1', ['T-1.1.1', 'T-1.1.2'])];
    const lineage = splitLineage(records, tasks, 'T-1.1.2');
    expect(lineage.map((ancestor) => ancestor.id)).toEqual(['T-1.1', 'T-1']);
    expect(lineage[1]!.children).toEqual([
      { id: 'T-1.1', title: 'Planned T-1.1', passes: null },
      { id: 'T-1.2', title: 'c', passes: false },
    ]);
  });

  it('is empty for a task not split from another, and stops at a loop or a task with no record', () => {
    expect(splitLineage([], [{ id: 'T-1', title: 'x', passes: false }], 'T-1')).toEqual([]);
    expect(splitLineage([], [{ id: 'T-1.1', title: 'x', passes: false, splitFrom: 'T-1' }], 'T-1.1')).toEqual([]);
    const loop = [record('A', ['B', 'X']), record('B', ['A', 'Y'])];
    expect(splitLineage(loop, [], 'A').map((ancestor) => ancestor.id)).toEqual(['B']);
  });
});
