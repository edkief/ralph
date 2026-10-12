import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffold, TEMPLATES_DIR } from '../src/init/scaffold.js';
import { planState, validatePlan } from '../src/init/plan.js';
import { spec, writePlan } from './helpers/plan.js';

function scaffolded(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-plan-'));
  scaffold(root);
  return root;
}

describe('planState', () => {
  it('sees a fresh scaffold as still the template', () => {
    expect(planState(scaffolded(), '.ralph')).toBe('template');
  });

  it('treats missing files as not yet written', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-plan-empty-'));
    expect(planState(root, '.ralph')).toBe('template');
  });

  it('sees a plan once the PRD or tasks hold real content', () => {
    const root = scaffolded();
    writeFileSync(resolve(root, '.ralph/prd/PRD.md'), '# Something real');
    expect(planState(root, '.ralph')).toBe('written');
  });

  it('still sees the task list an older Ralph scaffolded as the template', () => {
    const root = scaffolded();
    writeFileSync(
      resolve(root, '.ralph/tasks.json'),
      `${JSON.stringify(
        [
          {
            id: 'TASK-1',
            title: 'Short description of the first unit of work',
            category: 'setup',
            specFilePath: '.ralph/tasks/TASK-1.json',
            passes: false,
          },
        ],
        null,
        2,
      )}\n`,
    );
    expect(planState(root, '.ralph')).toBe('template');
    expect(validatePlan(root, '.ralph')).toContain('.ralph/tasks.json is still the template');
  });
});

describe('validatePlan', () => {
  it('accepts a complete plan', () => {
    const root = scaffolded();
    writePlan(root);
    expect(validatePlan(root, '.ralph')).toEqual([]);
  });

  it('flags files still holding the templates', () => {
    expect(validatePlan(scaffolded(), '.ralph')).toEqual([
      '.ralph/prd/PRD.md is still the template',
      '.ralph/tasks.json is still the template',
    ]);
  });

  it('flags ids the loop could not recognise, duplicates and empty titles', () => {
    const root = scaffolded();
    // Both entries share one spec, the last one written.
    writePlan(root, [{ id: 'setup-1' }, { id: 'TASK-2' }, { id: 'TASK-2', title: ' ' }]);
    expect(validatePlan(root, '.ralph')).toEqual([
      'task setup-1: id must look like TASK-1',
      'task TASK-2: title is empty',
      'task TASK-2: duplicate id',
    ]);
  });

  it('requires new tasks to start failing, except when replanning', () => {
    const root = scaffolded();
    writePlan(root, [{ id: 'TASK-1', passes: true }]);
    expect(validatePlan(root, '.ralph')).toEqual(['task TASK-1: a new task must have "passes": false']);
    expect(validatePlan(root, '.ralph', { replan: true })).toEqual([]);
  });

  it('checks every spec exists, matches its task and has acceptance criteria', () => {
    const root = scaffolded();
    writePlan(root, [{ id: 'TASK-1' }, { id: 'TASK-2' }, { id: 'TASK-3' }, { id: 'TASK-4' }], {
      'TASK-1': undefined,
      'TASK-2': '{nope',
      'TASK-3': spec('TASK-9'),
      'TASK-4': spec('TASK-4', { acceptanceCriteria: [] }),
    });

    const problems = validatePlan(root, '.ralph');
    expect(problems).toHaveLength(4);
    expect(problems[0]).toBe('task TASK-1: spec .ralph/tasks/TASK-1.json does not exist');
    expect(problems[1]).toMatch(/^task TASK-2: spec .* is not valid JSON/);
    expect(problems[2]).toBe('task TASK-3: spec .ralph/tasks/TASK-3.json has id "TASK-9", expected "TASK-3"');
    expect(problems[3]).toMatch(/^task TASK-4: .* non-empty acceptanceCriteria/);
  });

  it('flags a spec the list leaves out, which would otherwise run last', () => {
    const root = scaffolded();
    writePlan(root, [{ id: 'TASK-1' }, { id: 'TASK-2' }]);
    for (const id of ['TASK-3', 'TASK-4']) writeFileSync(resolve(root, `.ralph/tasks/${id}.json`), JSON.stringify(spec(id)));
    expect(validatePlan(root, '.ralph')).toEqual([
      '.ralph/tasks/TASK-3.json is not in .ralph/tasks.json: list it where it should run, or delete it if the task is dropped',
      '.ralph/tasks/TASK-4.json is not in .ralph/tasks.json: list it where it should run, or delete it if the task is dropped',
    ]);
  });

  it('takes a title from the spec, not the list', () => {
    const root = scaffolded();
    writePlan(root, [{ id: 'TASK-1' }]);
    writeFileSync(resolve(root, '.ralph/tasks.json'), JSON.stringify([{ id: 'TASK-1', title: 'Listed', passes: false }]));
    writeFileSync(resolve(root, '.ralph/tasks/TASK-1.json'), JSON.stringify(spec('TASK-1', { title: '' })));
    expect(validatePlan(root, '.ralph')).toEqual(['task TASK-1: title is empty']);
  });

  it('accepts a plan of one task, though its list reads like the template', () => {
    const root = scaffolded();
    writePlan(root, [{ id: 'TASK-1' }]);
    copyFileSync(resolve(TEMPLATES_DIR, 'tasks.json'), resolve(root, '.ralph/tasks.json'));
    expect(validatePlan(root, '.ralph')).toEqual([]);
    expect(planState(root, '.ralph')).toBe('written');
  });

  it('flags an example spec left as the template', () => {
    const root = scaffolded();
    writePlan(root);
    copyFileSync(resolve(TEMPLATES_DIR, 'TASK-1.json'), resolve(root, '.ralph/tasks/TASK-1.json'));
    expect(validatePlan(root, '.ralph')).toEqual(['task TASK-1: spec .ralph/tasks/TASK-1.json is still the template']);
  });

  it('reports an unreadable task list', () => {
    const root = scaffolded();
    writePlan(root);
    writeFileSync(resolve(root, '.ralph/tasks.json'), '[{"title": "no id"}]');
    expect(validatePlan(root, '.ralph')[0]).toMatch(/does not match the expected task shape/);
  });
});
