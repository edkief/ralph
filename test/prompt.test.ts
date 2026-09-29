import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, PromptError } from '../src/prompt/build.js';

function project(promptBody = '# Do the work', dir = '.ralph'): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-prompt-'));
  mkdirSync(resolve(root, dir), { recursive: true });
  writeFileSync(resolve(root, dir, 'PROMPT.md'), promptBody);
  return root;
}

const task = { id: 'TASK-4', title: 'Add the widget', passes: false, specFilePath: '.ralph/tasks/TASK-4.json' };

describe('buildPrompt', () => {
  it('includes the project prompt and run context', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      ralphDir: '.ralph',
      iteration: 2,
      maxIterations: 9,
      pinTask: false,
    });

    expect(prompt).toContain('PROJECT_ROOT=');
    expect(prompt).toContain('RALPH_ITERATION=2 of 9');
    expect(prompt).toContain('# Do the work');
  });

  it('pins the selected task so the model does not have to choose', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      ralphDir: '.ralph',
      iteration: 1,
      maxIterations: 5,
      nextTask: task,
      pinTask: true,
    });

    expect(prompt).toContain('TASK-4');
    expect(prompt).toContain('Add the widget');
    expect(prompt).toContain('.ralph/tasks/TASK-4.json');
    expect(prompt).toContain('Do not pick a different task');
  });

  it('leaves task selection to the agent when pinning is off', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      ralphDir: '.ralph',
      iteration: 1,
      maxIterations: 5,
      nextTask: task,
      pinTask: false,
    });
    expect(prompt).not.toContain('Do not pick a different task');
  });

  it('fails clearly when PROMPT.md is missing', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-prompt-empty-'));
    expect(() =>
      buildPrompt({ projectRoot: root, ralphDir: '.ralph', iteration: 1, maxIterations: 1, pinTask: true }),
    ).toThrow(PromptError);
  });

  it('replaces {{RALPH_DIR}} with the resolved folder, relative to the root', () => {
    const body = 'Read @{{RALPH_DIR}}/prd/PRD.md and update {{RALPH_DIR}}/tasks.json.';
    const withDir = (dir: string, ralphDir = dir) =>
      buildPrompt({
        projectRoot: project(body, dir),
        ralphDir,
        iteration: 1,
        maxIterations: 1,
        pinTask: false,
      });

    const prompt = withDir('.ralph');
    expect(prompt).toContain('Read @.ralph/prd/PRD.md and update .ralph/tasks.json.');
    expect(prompt).not.toContain('{{RALPH_DIR}}');

    expect(withDir('.agent')).toContain('Read @.agent/prd/PRD.md');
    expect(withDir('docs/ralph', './docs/ralph/')).toContain('Read @docs/ralph/prd/PRD.md');
  });

  it('passes a prompt without the placeholder through unchanged', () => {
    const body = 'Read @.agent/prd/PRD.md, then work on the task.\n';
    const prompt = buildPrompt({
      projectRoot: project(body, '.agent'),
      ralphDir: '.agent',
      iteration: 1,
      maxIterations: 1,
      pinTask: false,
    });
    expect(prompt.endsWith(`\n\n${body}`)).toBe(true);
  });

  it('renders the shipped template with no placeholder or hardcoded folder left', () => {
    const root = project();
    copyFileSync(resolve(import.meta.dirname, '../templates/PROMPT.md'), resolve(root, '.ralph/PROMPT.md'));
    const prompt = buildPrompt({ projectRoot: root, ralphDir: '.ralph', iteration: 1, maxIterations: 1, pinTask: false });

    expect(prompt).toContain('@.ralph/prd/PRD.md');
    expect(prompt).not.toContain('{{');
    expect(prompt).not.toContain('.agent/');
  });
});
