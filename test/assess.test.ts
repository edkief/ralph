import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEstimate, shouldAssess, thresholdMs } from '../src/loop/assess.js';
import { buildAssessPrompt } from '../src/prompt/assess.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';

function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-assess-'));
  mkdirSync(resolve(root, '.ralph'), { recursive: true });
  return root;
}

function config(root: string, overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ projectRoot: root, assess: { mode: 'split' }, ...overrides });
}

describe('parseEstimate', () => {
  it('reads the minutes and the reason', () => {
    expect(parseEstimate('Plan: …\n<promise>ESTIMATE:50:three separate changes</promise>')).toEqual({
      minutes: 50,
      reason: 'three separate changes',
    });
    expect(parseEstimate('<promise> estimate: 20 minutes : small </promise>')).toEqual({ minutes: 20, reason: 'small' });
    expect(parseEstimate('<promise>ESTIMATE:12.5</promise>')).toEqual({ minutes: 12.5, reason: '' });
  });

  it('finds none in a reply without a usable tag', () => {
    expect(parseEstimate('About an hour, I think.')).toBeUndefined();
    expect(parseEstimate('<promise>ESTIMATE:soon:no idea</promise>')).toBeUndefined();
    expect(parseEstimate('<promise>ESTIMATE:0:nothing to do</promise>')).toBeUndefined();
  });
});

describe('thresholdMs', () => {
  it('follows the iteration budget unless set', () => {
    const root = project();
    expect(thresholdMs(config(root, { timeouts: { iterationMs: 1_200_000 } }))).toBe(1_200_000);
    expect(thresholdMs(config(root, { assess: { mode: 'split', thresholdMs: 600_000 } }))).toBe(600_000);
  });
});

describe('shouldAssess', () => {
  const task = { id: 'TASK-1', title: 'Parser', passes: false };

  it('assesses a task nobody assessed or started', () => {
    const root = project();
    expect(shouldAssess(config(root), task)).toBe(true);
    expect(shouldAssess(config(root, { assess: { mode: 'off' } }), task)).toBe(false);
  });

  it('leaves alone a task already assessed, one with a handoff, and one that cannot be split again', () => {
    const assessed = project();
    mkdirSync(resolve(assessed, '.ralph', 'assess'));
    writeFileSync(resolve(assessed, '.ralph', 'assess', 'TASK-1.json'), '{}');
    expect(shouldAssess(config(assessed), task)).toBe(false);

    const started = project();
    mkdirSync(resolve(started, '.ralph', 'handoff'));
    writeFileSync(resolve(started, '.ralph', 'handoff', 'TASK-1.md'), '## Done\n');
    expect(shouldAssess(config(started), task)).toBe(false);

    const root = project();
    expect(shouldAssess(config(root), { ...task, splitDepth: 1 })).toBe(false);
    expect(shouldAssess(config(root, { stall: { maxSplitDepth: 2 } }), { ...task, splitDepth: 1 })).toBe(true);
  });
});

describe('buildAssessPrompt', () => {
  const prompt = buildAssessPrompt({
    projectRoot: '/work/app',
    taskId: 'TASK-3',
    title: 'Parser',
    specPath: '.ralph/tasks/TASK-3.json',
    specText: '{ "id": "TASK-3" }',
    iterationMs: 30 * 60_000,
    thresholdMs: 25 * 60_000,
    timeoutMs: 5 * 60_000,
  });

  it('gives the spec, the budgets and the tag to answer with', () => {
    expect(prompt).toContain('## Assess TASK-3');
    expect(prompt).toContain('{ "id": "TASK-3" }');
    expect(prompt).toContain('about 30 minutes');
    expect(prompt).toContain('more than 25 minutes');
    expect(prompt).toContain('You have 5 minutes');
    expect(prompt).toContain('<promise>ESTIMATE:minutes:why, in one sentence</promise>');
  });

  it('keeps the agent to planning', () => {
    expect(prompt).toContain('to plan and estimate, not to implement');
    expect(prompt).toContain('Do not start on the task');
    expect(prompt).toContain('run no builds, tests or installs');
  });
});
