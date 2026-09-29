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

/** Write a plan the way a well-behaved agent would. */
export function writePlan(
  root: string,
  tasks: Array<Record<string, unknown>> = [{ id: 'TASK-1' }, { id: 'TASK-2' }],
  specs: Record<string, unknown> = {},
): void {
  writeFileSync(resolve(root, '.ralph/prd/PRD.md'), '# Todo app\n\n## Goals\n\n- Track todos.\n');
  mkdirSync(resolve(root, '.ralph/tasks'), { recursive: true });
  rmSync(resolve(root, '.ralph/tasks/TASK-1.json'), { force: true });
  const full = tasks.map((task) => ({
    title: `Do ${String(task['id'])}`,
    specFilePath: `.ralph/tasks/${String(task['id'])}.json`,
    passes: false,
    ...task,
  }));
  writeFileSync(resolve(root, '.ralph/tasks.json'), JSON.stringify(full, null, 2));
  for (const task of full) {
    const id = String(task.id);
    const body = id in specs ? specs[id] : spec(id);
    if (body !== undefined && task.specFilePath) {
      writeFileSync(resolve(root, String(task.specFilePath)), typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
}
