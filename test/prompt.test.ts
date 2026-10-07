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

  it('states the time budget and when it ends', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      ralphDir: '.ralph',
      iteration: 1,
      maxIterations: 5,
      pinTask: true,
      nextTask: task,
      timeBudget: { ms: 45 * 60_000, until: new Date(2026, 8, 30, 14, 3) },
    });

    expect(prompt).toContain('You have about 45 minutes, until 14:03:00');
    expect(prompt).toContain('commit working checkpoints');
    expect(prompt).toContain('nothing resumes you when a background job finishes');
  });

  it('hands the next attempt the handoff an earlier one left', () => {
    const root = project();
    const prompt = buildPrompt({
      projectRoot: root,
      ralphDir: '.ralph',
      iteration: 3,
      maxIterations: 5,
      pinTask: true,
      nextTask: task,
      handoff: { path: resolve(root, '.ralph/handoff/TASK-4.md'), text: '## Status\n\nHalfway there.' },
    });

    expect(prompt).toContain('## Resuming TASK-4');
    expect(prompt).toContain('`.ralph/handoff/TASK-4.md`');
    expect(prompt).toContain('Halfway there.');
    // Before the project prompt, next to the task it belongs to.
    expect(prompt.indexOf('## Resuming')).toBeLessThan(prompt.indexOf('# Do the work'));
  });

  it('shows what a person or the escalation agent answered, and leaves the section out when there is nothing', () => {
    const root = project();
    const base = { projectRoot: root, ralphDir: '.ralph', iteration: 1, maxIterations: 5, pinTask: false };
    expect(buildPrompt(base)).not.toContain('## Decisions');

    const prompt = buildPrompt({
      ...base,
      decisions: [
        { time: 't', runId: 'r', taskId: 'TASK-4', kind: 'decide', question: 'REST or\nGraphQL?', answer: 'REST.\nKeep it simple.' },
        { time: 't', runId: 'r', taskId: null, kind: 'stalled', answer: 'Use the staging database.' },
        { time: 't', runId: 'r', taskId: 'TASK-5', kind: 'blocked', question: 'no network', answer: 'It is up now.', by: 'agent' },
      ],
    });
    expect(prompt).toContain('## Decisions');
    expect(prompt).toContain('`.ralph/decisions.jsonl`');
    expect(prompt).toContain('- TASK-4: REST or GraphQL?\n  **REST.\n  Keep it simple.**');
    expect(prompt).toContain('- note\n  **Use the staging database.**');
    expect(prompt).toContain('- TASK-5: no network (escalation agent)\n  **It is up now.**');
  });

  it('tells a task made by a split which task it came from, and where that one stopped', () => {
    const root = project();
    const base = { projectRoot: root, ralphDir: '.ralph', iteration: 1, maxIterations: 5, pinTask: true };
    const child = { id: 'TASK-4.2', title: 'Render it', passes: false, splitFrom: 'TASK-4' };
    expect(buildPrompt({ ...base, nextTask: child })).not.toContain('## Split from');

    const prompt = buildPrompt({
      ...base,
      nextTask: child,
      handoff: { path: resolve(root, '.ralph/handoff/TASK-4.2.md'), text: 'Mine.' },
      lineage: [
        {
          id: 'TASK-4',
          title: 'Add the widget',
          specFilePath: '.ralph/split/TASK-4/TASK-4.json',
          handoffPath: '.ralph/split/TASK-4/handoff.md',
          children: [
            { id: 'TASK-4.1', title: 'Model it', passes: true },
            { id: 'TASK-4.2', title: 'Render it', passes: false },
            { id: 'TASK-4.3', title: 'Document it', passes: false },
          ],
        },
      ],
    });
    expect(prompt).toContain('## Split from TASK-4');
    expect(prompt).toContain('TASK-4.2 is part of TASK-4 (Add the widget)');
    expect(prompt).toContain('`.ralph/split/TASK-4/TASK-4.json`');
    expect(prompt).toContain('Where its last attempt stopped: `.ralph/split/TASK-4/handoff.md`');
    expect(prompt).toContain('`git log --grep=TASK-4`');
    expect(prompt).toContain('  ✓ TASK-4.1 — Model it\n  ▶ TASK-4.2 — Render it (this task)\n  ○ TASK-4.3 — Document it');
    expect(prompt).toContain('Do only TASK-4.2.');
    // After the task, before its own handoff.
    expect(prompt.indexOf('## Your task')).toBeLessThan(prompt.indexOf('## Split from'));
    expect(prompt.indexOf('## Split from')).toBeLessThan(prompt.indexOf('## Resuming'));
  });

  it('follows a task split twice, and does without a title, spec or handoff', () => {
    const prompt = buildPrompt({
      projectRoot: project(),
      ralphDir: '.ralph',
      iteration: 1,
      maxIterations: 5,
      pinTask: true,
      nextTask: { id: 'TASK-4.1.2', title: 'b', passes: false, splitFrom: 'TASK-4.1' },
      lineage: [
        { id: 'TASK-4.1', title: 'Model it', children: [{ id: 'TASK-4.1.1', title: 'a', passes: true }, { id: 'TASK-4.1.2', title: 'b', passes: false }] },
        { id: 'TASK-4', title: null, children: [{ id: 'TASK-4.1', title: 'Model it', passes: null }, { id: 'TASK-4.2', title: 'Render it', passes: false }] },
      ],
    });
    expect(prompt).toContain('## Split from TASK-4.1');
    expect(prompt).toContain('TASK-4.1 (Model it) was itself split from TASK-4:');
    expect(prompt).toContain('  ▶ TASK-4.1 — Model it (which TASK-4.1.2 is part of)\n  ○ TASK-4.2 — Render it');
    expect(prompt).not.toContain('Its spec');
    expect(prompt).not.toContain('Where its last attempt stopped');
  });
});
