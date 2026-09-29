import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, PromptError } from '../src/prompt/build.js';

function project(promptBody = '# Do the work'): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-prompt-'));
  mkdirSync(resolve(root, '.agent'), { recursive: true });
  writeFileSync(resolve(root, '.agent/PROMPT.md'), promptBody);
  return root;
}

const task = { id: 'TASK-4', title: 'Add the widget', passes: false, specFilePath: '.agent/tasks/TASK-4.json' };

describe('buildPrompt', () => {
  it('includes the project prompt and run context', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      agentDir: '.agent',
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
      agentDir: '.agent',
      iteration: 1,
      maxIterations: 5,
      nextTask: task,
      pinTask: true,
    });

    expect(prompt).toContain('TASK-4');
    expect(prompt).toContain('Add the widget');
    expect(prompt).toContain('.agent/tasks/TASK-4.json');
    expect(prompt).toContain('Do not pick a different task');
  });

  it('leaves task selection to the agent when pinning is off', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      agentDir: '.agent',
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
      buildPrompt({ projectRoot: root, agentDir: '.agent', iteration: 1, maxIterations: 1, pinTask: true }),
    ).toThrow(PromptError);
  });
});
