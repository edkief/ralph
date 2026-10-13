import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAssessment, readDecisions, readProposal, readSpec, recognise } from '../web/src/ralph-files.js';

const TEMPLATE_SPEC = readFileSync(resolve(import.meta.dirname, '..', 'templates', 'TASK-1.json'), 'utf8');

describe('recognise', () => {
  it('knows specs, split proposals, assessments and decisions by where they are', () => {
    expect(recognise('.ralph/tasks/TASK-1.json', '.ralph')).toBe('spec');
    expect(recognise('.ralph/tasks/TASK-8.2.json', '.ralph')).toBe('spec');
    expect(recognise('.ralph/split/TASK-8/TASK-8.json', '.ralph')).toBe('spec');
    expect(recognise('.ralph/split/TASK-8/TASK-8.1.json', '.ralph')).toBe('spec');
    expect(recognise('.ralph/split/TASK-8/proposal.json', '.ralph')).toBe('proposal');
    expect(recognise('.ralph/assess/TASK-3.json', '.ralph')).toBe('assessment');
    expect(recognise('.ralph/decisions.jsonl', '.ralph')).toBe('decisions');
  });

  it('follows ralphDir however it is written', () => {
    expect(recognise('ops/agent/tasks/TASK-1.json', 'ops/agent/')).toBe('spec');
    expect(recognise('ops/agent/decisions.jsonl', './ops/agent')).toBe('decisions');
    expect(recognise('.ralph/tasks/TASK-1.json', 'ops/agent')).toBeNull();
  });

  it('leaves the rest alone', () => {
    expect(recognise('.ralph/tasks.json', '.ralph')).toBeNull();
    expect(recognise('ralph.config.json', '.ralph')).toBeNull();
    expect(recognise('.ralph/tasks/notes.json', '.ralph')).toBeNull();
    expect(recognise('.ralph/tasks/TASK-1.md', '.ralph')).toBeNull();
    expect(recognise('.ralph/artifacts/TASK-1/report.json', '.ralph')).toBeNull();
    expect(recognise('.ralph/split/TASK-8/handoff.md', '.ralph')).toBeNull();
    expect(recognise('.ralph/split/notes/proposal.json', '.ralph')).toBeNull();
    expect(recognise('.ralph/logs/decisions.jsonl', '.ralph')).toBeNull();
    expect(recognise('.ralph-old/tasks/TASK-1.json', '.ralph')).toBeNull();
  });
});

describe('readSpec', () => {
  it('reads the template spec', () => {
    const spec = readSpec(TEMPLATE_SPEC);
    expect(spec).toMatchObject({
      id: 'TASK-1',
      title: 'Short description of the first unit of work',
      category: 'setup',
      steps: ['First concrete step', 'Second concrete step'],
      acceptanceCriteria: ['An observable result a reviewer can check', 'Tests covering the new behaviour pass'],
      extra: [],
    });
    expect(spec?.description).toMatch(/^What this task delivers/);
    expect(spec?.notes).toMatch(/^Constraints/);
  });

  it('keeps the fields it has no place for, and where it came from', () => {
    const spec = readSpec(
      JSON.stringify({
        id: 'TASK-8.1',
        title: 'Half of it',
        splitFrom: 'TASK-8',
        splitDepth: 1,
        steps: ['one', { run: 'npm test' }],
        dependencies: ['TASK-2'],
        estimate: 30,
      }),
    );
    expect(spec).toMatchObject({ splitFrom: 'TASK-8', splitDepth: 1, steps: ['one', '{"run":"npm test"}'], acceptanceCriteria: [] });
    expect(spec?.extra).toEqual([
      ['dependencies', ['TASK-2']],
      ['estimate', 30],
    ]);
  });

  it('is null for a file that is not a spec', () => {
    expect(readSpec('{ "id": "TASK-1", ')).toBeNull();
    expect(readSpec('[{ "id": "TASK-1" }]')).toBeNull();
    expect(readSpec('{ "title": "no id" }')).toBeNull();
  });
});

describe('readProposal', () => {
  it('reads an applied split, with what the split task was', () => {
    const proposal = readProposal(
      JSON.stringify({
        task: 'TASK-8',
        splittable: true,
        reason: 'Two independent halves',
        tasks: [
          { id: 'TASK-8.1', title: 'API' },
          { id: 'TASK-8.2', title: 'UI' },
        ],
        appliedAt: '2026-10-01T10:00:00.000Z',
        parent: { title: 'Everything', specFilePath: '.ralph/split/TASK-8/TASK-8.json', handoffPath: '.ralph/split/TASK-8/handoff.md' },
      }),
    );
    expect(proposal).toEqual({
      task: 'TASK-8',
      splittable: true,
      retry: false,
      reason: 'Two independent halves',
      tasks: [
        { id: 'TASK-8.1', title: 'API' },
        { id: 'TASK-8.2', title: 'UI' },
      ],
      appliedAt: '2026-10-01T10:00:00.000Z',
      parent: { title: 'Everything', specFilePath: '.ralph/split/TASK-8/TASK-8.json', handoffPath: '.ralph/split/TASK-8/handoff.md' },
    });
  });

  it('reads advice against splitting, and a retry', () => {
    expect(readProposal(JSON.stringify({ task: 'TASK-3', splittable: false, retry: true, reason: 'Nearly done' }))).toEqual({
      task: 'TASK-3',
      splittable: false,
      retry: true,
      reason: 'Nearly done',
      tasks: [],
    });
  });

  it('is null for a file that is not a proposal', () => {
    expect(readProposal('not json')).toBeNull();
    expect(readProposal(JSON.stringify({ task: 'TASK-3', reason: 'no verdict' }))).toBeNull();
  });
});

describe('readAssessment', () => {
  it('reads an estimate against the threshold', () => {
    const assessment = readAssessment(
      JSON.stringify({
        task: 'TASK-4',
        verdict: 'too-big',
        estimateMinutes: 90,
        thresholdMinutes: 45,
        reason: 'Three services',
        assessedAt: '2026-10-01T10:00:00.000Z',
      }),
    );
    expect(assessment).toEqual({
      task: 'TASK-4',
      verdict: 'too-big',
      estimateMinutes: 90,
      thresholdMinutes: 45,
      reason: 'Three services',
      assessedAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('reads one with no estimate', () => {
    expect(readAssessment(JSON.stringify({ task: 'TASK-4', verdict: 'unknown', thresholdMinutes: 45, reason: 'timed out' }))).toEqual({
      task: 'TASK-4',
      verdict: 'unknown',
      thresholdMinutes: 45,
      reason: 'timed out',
    });
  });

  it('is null for a file that is not an assessment', () => {
    expect(readAssessment(JSON.stringify({ task: 'TASK-4' }))).toBeNull();
  });
});

describe('readDecisions', () => {
  it('reads each decision, newest first, skipping lines that do not read', () => {
    const content = [
      JSON.stringify({ time: '2026-10-01T10:00:00.000Z', runId: 'r1', taskId: 'TASK-1', kind: 'question', question: 'Which DB?', answer: 'Postgres' }),
      '{ broken',
      '',
      JSON.stringify({ time: '2026-10-01T11:00:00.000Z', runId: 'r1', taskId: null, kind: 'note', answer: 'Skip the docs', by: 'agent' }),
      JSON.stringify({ time: '2026-10-01T12:00:00.000Z', runId: 'r2', kind: 'note', answer: '' }),
    ].join('\n');
    expect(readDecisions(content)).toEqual([
      { time: '2026-10-01T11:00:00.000Z', runId: 'r1', taskId: null, kind: 'note', answer: 'Skip the docs', by: 'agent' },
      { time: '2026-10-01T10:00:00.000Z', runId: 'r1', taskId: 'TASK-1', kind: 'question', question: 'Which DB?', answer: 'Postgres' },
    ]);
  });

  it('is null when no line reads as a decision', () => {
    expect(readDecisions('')).toBeNull();
    expect(readDecisions('{ broken\n[]\n')).toBeNull();
  });
});
