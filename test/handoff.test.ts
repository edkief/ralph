import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_HEADINGS,
  ensureHandoff,
  handoffPath,
  missingHeadings,
  readHandoff,
} from '../src/loop/handoff.js';
import { buildWrapUpPrompt } from '../src/prompt/wrapup.js';
import { buildResumePrompt } from '../src/prompt/resume.js';
import { handoffCheck } from '../src/opencode/preflight.js';
import { ConfigSchema } from '../src/config/schema.js';

const complete = HANDOFF_HEADINGS.map((heading) => `## ${heading}\n\nSomething.`).join('\n\n');

function repo(): { root: string; head: () => string } {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-handoff-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(resolve(root, 'README.md'), 'start');
  git('add', '-A');
  git('commit', '-qm', 'chore: start');
  return { root, head: () => git('rev-parse', 'HEAD') };
}

function write(path: string, text: string, ageMs = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(path, then, then);
  }
}

describe('handoff', () => {
  it('lives in the handoff folder, one file per task', () => {
    expect(handoffPath('/p', '.ralph', 'TASK-3')).toBe('/p/.ralph/handoff/TASK-3.md');
  });

  it('checks for every heading', () => {
    expect(missingHeadings(complete)).toEqual([]);
    expect(missingHeadings('## Status\n\n## Done')).toEqual(['Working tree', 'Next steps', 'Dead ends', 'How to verify']);
  });

  it('trims a long handoff for the prompt', () => {
    const { root } = repo();
    const path = handoffPath(root, '.ralph', 'TASK-1');
    write(path, `${complete}\n${'x'.repeat(20_000)}`);
    const text = readHandoff(path)!;
    expect(text.length).toBeLessThan(9_000);
    expect(text).toMatch(/handoff truncated\]$/);
    expect(readHandoff(handoffPath(root, '.ralph', 'TASK-2'))).toBeUndefined();
  });

  it("keeps the agent's handoff when it is fresh and complete", async () => {
    const { root, head } = repo();
    const path = handoffPath(root, '.ralph', 'TASK-1');
    const since = Date.now() - 1_000;
    write(path, complete);

    const who = await ensureHandoff({
      path, projectRoot: root, taskId: 'TASK-1', iteration: 2, since, sinceHead: head(), reason: 'out of time', agentText: '',
    });

    expect(who).toBe('agent');
    expect(readFileSync(path, 'utf8')).toBe(complete);
  });

  it('writes one from what the loop saw when the agent left none', async () => {
    const { root, head } = repo();
    const start = head();
    writeFileSync(resolve(root, 'work.ts'), 'wip');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'wip(TASK-1): half a parser'], { cwd: root });
    writeFileSync(resolve(root, 'more.ts'), 'uncommitted');
    const path = handoffPath(root, '.ralph', 'TASK-1');

    const who = await ensureHandoff({
      path, projectRoot: root, taskId: 'TASK-1', iteration: 4, since: Date.now(), sinceHead: start,
      reason: 'No activity from the agent for 600s', agentText: 'Running the parser tests now.',
    });

    const text = readFileSync(path, 'utf8');
    expect(who).toBe('fallback');
    expect(missingHeadings(text)).toEqual([]);
    expect(text).toContain('Iteration 4 did not finish the task: No activity from the agent for 600s.');
    expect(text).toContain('wip(TASK-1): half a parser');
    expect(text).not.toContain('chore: start');
    expect(text).toContain('?? more.ts');
    expect(text).toContain('> Running the parser tests now.');
  });

  it('replaces a stale handoff, quoting it rather than trusting it', async () => {
    const { root, head } = repo();
    const path = handoffPath(root, '.ralph', 'TASK-1');
    write(path, `${complete}\n\nFrom attempt one.`, 60_000);

    const who = await ensureHandoff({
      path, projectRoot: root, taskId: 'TASK-1', iteration: 5, since: Date.now() - 1_000, sinceHead: head(), reason: 'out of time', agentText: '',
    });

    const text = readFileSync(path, 'utf8');
    expect(who).toBe('fallback');
    expect(text).toContain('## An earlier handoff');
    expect(text).toContain('## Working tree\n\nClean.');
    expect(text).toContain('> From attempt one.');
  });
  it('says when the agent ended its turn early rather than running out of time', async () => {
    const { root, head } = repo();
    const path = handoffPath(root, '.ralph', 'TASK-1');

    await ensureHandoff({
      path, projectRoot: root, taskId: 'TASK-1', iteration: 2, since: Date.now(), sinceHead: head(),
      reason: 'the agent ended its turn before finishing the task', cutShortBy: 'early-stop',
      agentText: 'Both jobs are still running. Ending here.',
    });

    const text = readFileSync(path, 'utf8');
    expect(missingHeadings(text)).toEqual([]);
    expect(text).toContain('the agent ended its turn before finishing the task, without leaving a complete handoff');
    expect(text).not.toContain('ran out of');
    expect(text).toContain('Nothing resumes a session once its turn ends');
    expect(text).toContain('> Both jobs are still running. Ending here.');
  });
});

describe('buildResumePrompt', () => {
  it('tells the agent nothing will wake it, to wait for its jobs and finish, or hand off', () => {
    const prompt = buildResumePrompt({ taskId: 'TASK-7', handoffPath: '.ralph/handoff/TASK-7.md', leftMs: 12 * 60_000 });

    expect(prompt).toContain('## Carry on with TASK-7');
    expect(prompt).toContain('Nothing resumes you when a background job finishes');
    expect(prompt).toContain('wait for it now');
    expect(prompt).toContain('<promise>TASK-7:DONE</promise>');
    expect(prompt).toContain('about 12 minutes');
    expect(prompt).toContain('`.ralph/handoff/TASK-7.md`');
    for (const heading of HANDOFF_HEADINGS) expect(prompt).toContain(heading);
    expect(prompt).toContain('wip(TASK-7)');
    expect(prompt).not.toContain('BLOCKED');
  });
});

describe('buildWrapUpPrompt', () => {
  it('asks for a handoff, not for the task to be finished', () => {
    const prompt = buildWrapUpPrompt({
      taskId: 'TASK-7', handoffPath: '.ralph/handoff/TASK-7.md', trigger: 'iteration-timeout', wrapUpMs: 600_000,
    });

    expect(prompt).toContain('about 10 minutes');
    expect(prompt).toContain('`.ralph/handoff/TASK-7.md`');
    for (const heading of HANDOFF_HEADINGS) expect(prompt).toContain(`## ${heading}`);
    expect(prompt).toContain('wip(TASK-7)');
    expect(prompt).toContain('Do not set `passes: true`');
  });

  it('asks for no promise tag, since running out of time is not being blocked', () => {
    for (const trigger of ['iteration-timeout', 'park'] as const) {
      const prompt = buildWrapUpPrompt({
        taskId: 'TASK-7', handoffPath: '.ralph/handoff/TASK-7.md', trigger, wrapUpMs: 600_000,
      });
      expect(prompt).toContain('End without any promise tag');
      expect(prompt).toContain('Running out of time is not being blocked');
      expect(prompt).not.toContain('<promise>BLOCKED');
    }
  });

  it('warns a quiet agent off the command that hung', () => {
    const prompt = buildWrapUpPrompt({
      taskId: 'TASK-7', handoffPath: '.ralph/handoff/TASK-7.md', trigger: 'inactivity', wrapUpMs: 60_000,
    });
    expect(prompt).toContain('Do not run that command again');
    expect(prompt).toContain('about 1 minute to');
    // A hung command may be the environment problem BLOCKED is for.
    expect(prompt).toContain('End without any promise tag');
    expect(prompt).toContain('<promise>BLOCKED:reason</promise>');
  });
});

describe('handoffCheck', () => {
  const setup = (tasks: Array<{ id: string; passes: boolean }>, handoffs: string[]) => {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-doctor-'));
    mkdirSync(resolve(root, '.ralph', 'handoff'), { recursive: true });
    writeFileSync(resolve(root, '.ralph', 'tasks.json'), JSON.stringify(tasks));
    for (const id of handoffs) writeFileSync(resolve(root, '.ralph', 'handoff', `${id}.md`), complete);
    return ConfigSchema.parse({ projectRoot: root });
  };

  it('says nothing when no task has a handoff', () => {
    expect(handoffCheck(setup([{ id: 'TASK-1', passes: false }], []))).toBeUndefined();
  });

  it('lists the tasks that will resume', () => {
    expect(handoffCheck(setup([{ id: 'TASK-1', passes: false }], ['TASK-1']))).toMatchObject({
      ok: true,
      detail: 'resuming from a handoff: TASK-1',
    });
  });

  it('warns about handoffs left behind', () => {
    const result = handoffCheck(
      setup([{ id: 'TASK-1', passes: true }, { id: 'TASK-2', passes: false }], ['TASK-1', 'TASK-2', 'TASK-9']),
    );
    expect(result).toMatchObject({ ok: false, fatal: false });
    expect(result?.detail).toMatch(/delete them: TASK-1, TASK-9$/);
  });
});
