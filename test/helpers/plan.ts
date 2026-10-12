import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const spec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Do ${id}`,
  description: 'Something concrete.',
  steps: ['one'],
  acceptanceCriteria: ['npm test passes'],
  ...extra,
});

/**
 * Write a plan the way a well-behaved agent would: the ordered list of ids and
 * status, and a spec per task. A task's `title` goes in its spec; `specs`
 * overrides a spec's contents, and `undefined` leaves the spec out.
 */
export function writePlan(
  root: string,
  tasks: Array<Record<string, unknown>> = [{ id: 'TASK-1' }, { id: 'TASK-2' }],
  specs: Record<string, unknown> = {},
): void {
  writeFileSync(resolve(root, '.ralph/prd/PRD.md'), '# Todo app\n\n## Goals\n\n- Track todos.\n');
  mkdirSync(resolve(root, '.ralph/tasks'), { recursive: true });
  rmSync(resolve(root, '.ralph/tasks/TASK-1.json'), { force: true });
  const list = tasks.map(({ title: _title, ...task }) => ({ passes: false, ...task }));
  writeFileSync(resolve(root, '.ralph/tasks.json'), JSON.stringify(list, null, 2));
  for (const task of tasks) {
    const id = String(task['id']);
    const body = id in specs ? specs[id] : spec(id, task['title'] === undefined ? {} : { title: task['title'] });
    if (body !== undefined) {
      writeFileSync(resolve(root, `.ralph/tasks/${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
}
