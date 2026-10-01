import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionsFor,
  checkAnswer,
  clearPending,
  readAnswer,
  readPending,
  readStopRequest,
  requestStop,
  RespondError,
  waitForAnswer,
  writeAnswer,
  writePending,
  type Answer,
  type PendingRequest,
} from '../src/human/request.js';
import { recentDecisions, recordDecision } from '../src/human/decisions.js';

const folder = () => mkdtempSync(resolve(tmpdir(), 'ralph-human-'));
const pending = (patch: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'run-1',
  runId: 'run',
  kind: 'decide',
  taskId: 'TASK-1',
  message: 'REST or GraphQL?',
  question: 'REST or GraphQL?',
  waiting: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...patch,
});
const answer = (patch: Partial<Answer> = {}): Answer => ({
  id: 'run-1',
  action: 'answer',
  text: 'REST',
  by: 'ui',
  answeredAt: '2026-10-01T00:01:00.000Z',
  ...patch,
});

describe('requests for a person', () => {
  it('round-trips a request and its answer, and clears both', () => {
    const root = folder();
    expect(readPending(root)).toBeUndefined();

    writePending(root, pending());
    writeAnswer(root, answer());
    expect(readPending(root)).toEqual(pending());
    expect(readAnswer(root)).toEqual(answer());

    clearPending(root);
    expect(readPending(root)).toBeUndefined();
    expect(readAnswer(root)).toBeUndefined();
  });

  it('ignores files that are not what it wrote', () => {
    const root = folder();
    writeFileSync(resolve(root, 'pending.json'), '{"kind":"nonsense"}');
    writeFileSync(resolve(root, 'answer.json'), 'not json');
    expect(readPending(root)).toBeUndefined();
    expect(readAnswer(root)).toBeUndefined();
  });

  it('lets only the first answer to a request stand', () => {
    const root = folder();
    writeAnswer(root, answer());
    expect(() => writeAnswer(root, answer({ text: 'GraphQL' }))).toThrow(RespondError);
    expect(readAnswer(root)?.text).toBe('REST');

    // An answer nobody collected does not block the next request.
    writeAnswer(root, answer({ id: 'run-2' }));
    expect(readAnswer(root)?.id).toBe('run-2');
  });

  it('offers what fits the request and whether a loop waits', () => {
    expect(actionsFor('split', true)).toEqual(['approve', 'retry', 'repropose', 'stop']);
    expect(actionsFor('split', false)).toEqual(['approve', 'dismiss']);
    expect(actionsFor('decide', true)).toEqual(['answer', 'stop']);
    expect(actionsFor('decide', false)).toEqual(['answer', 'dismiss']);
    expect(actionsFor('blocked', true)).toEqual(['resume', 'stop']);
    expect(actionsFor('stalled', false)).toEqual(['dismiss']);
    expect(actionsFor('budget', true)).toEqual(['continue', 'stop']);
  });

  it('checks an answer against the request', () => {
    expect(checkAnswer(pending(), { id: 'run-1', action: 'answer', text: 'REST' }, true)).toBeUndefined();
    expect(checkAnswer(pending(), { id: 'run-0', action: 'answer', text: 'REST' }, true)).toContain('no longer pending');
    expect(checkAnswer(pending(), { id: 'run-1', action: 'approve' }, true)).toContain('choose one of: answer, stop');
    expect(checkAnswer(pending(), { id: 'run-1', action: 'answer', text: '  ' }, true)).toContain('needs text');
    expect(checkAnswer(pending(), { id: 'run-1', action: 'stop' }, false)).toContain('choose one of: answer, dismiss');
  });

  it('waits for the answer to its own request', async () => {
    const root = folder();
    writeAnswer(root, answer({ id: 'run-0' }));
    const waiting = waitForAnswer({ ralphRoot: root, id: 'run-1', signal: new AbortController().signal, pollMs: 5 });
    setTimeout(() => writeAnswer(root, answer()), 30);
    expect(await waiting).toEqual(answer());
  });

  it('stops waiting when aborted, or when the request was settled another way', async () => {
    const root = folder();
    const controller = new AbortController();
    const waiting = waitForAnswer({ ralphRoot: root, id: 'run-1', signal: controller.signal, pollMs: 5 });
    setTimeout(() => controller.abort(), 20);
    expect(await waiting).toBeUndefined();

    const settled = answer({ action: 'approve', by: 'cli' });
    expect(
      await waitForAnswer({ ralphRoot: root, id: 'run-1', signal: new AbortController().signal, pollMs: 5, settled: () => settled }),
    ).toBe(settled);
  });

  it('passes on a stop request', () => {
    const root = folder();
    expect(readStopRequest(root)).toBeUndefined();
    requestStop(root, 'now', 'ui');
    expect(readStopRequest(root)).toEqual({ mode: 'now' });
    expect(JSON.parse(readFileSync(resolve(root, 'stop.json'), 'utf8'))).toMatchObject({ by: 'ui' });
  });
});

describe('decisions', () => {
  it('keeps what a person said, returning the latest', () => {
    const root = folder();
    expect(recentDecisions(root, 5)).toEqual([]);

    for (const text of ['one', 'two', 'three']) {
      recordDecision(root, { time: 't', runId: 'r', taskId: 'TASK-1', kind: 'decide', question: 'q', answer: text });
    }
    writeFileSync(resolve(root, 'decisions.jsonl'), `${readFileSync(resolve(root, 'decisions.jsonl'), 'utf8')}broken\n{"answer":""}\n`);

    expect(recentDecisions(root, 2).map((decision) => decision.answer)).toEqual(['two', 'three']);
  });
});
