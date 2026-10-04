import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunRecorder, type IterationRecord, type SplitRecord } from '../src/report/jsonl.js';

const step = (created: number, input: number) => [
  { type: 'session.step.started', created, data: { sessionID: 's', model: { id: 'qwen3', providerID: 'ollama' } } },
  { type: 'session.step.ended', created: created + 100, data: { sessionID: 's', tokens: { input, output: 1 } } },
];

function recorder() {
  return new RunRecorder(mkdtempSync(resolve(tmpdir(), 'ralph-recorder-')), '20261004-120000');
}

function lines<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

const iteration = (n: number) =>
  ({ iteration: n, taskId: 'T-1', startedAt: '', endedAt: '' }) as unknown as IterationRecord;
const split = (status: SplitRecord['status']): SplitRecord => ({ iteration: 1, taskId: 'T-1', causes: [], status, startedAt: '', endedAt: '' });

describe('RunRecorder usage', () => {
  it('records each iteration with the usage of its own events', () => {
    const run = recorder();
    run.beginIteration(1);
    for (const event of step(0, 10)) run.recordEvent(event);
    for (const event of step(200, 20)) run.recordEvent(event);
    run.recordIteration(iteration(1));
    run.beginIteration(2);
    for (const event of step(0, 5)) run.recordEvent(event);
    run.recordIteration(iteration(2));

    const [first, second] = lines<IterationRecord>(resolve(run.directory, 'iterations.jsonl'));
    expect(first!.models).toEqual({ 'ollama/qwen3': expect.objectContaining({ steps: 2, input: 30, inferenceMs: 200 }) });
    expect(second!.models).toEqual({ 'ollama/qwen3': expect.objectContaining({ steps: 1, input: 5 }) });
  });

  it('records a split that carried on from an assessment with both turns', () => {
    const run = recorder();
    run.beginSplit('T-1');
    for (const event of step(0, 10)) run.recordEvent(event);
    // Too big: no record for the assessment; the split turn carries on in its file.
    for (const event of step(500, 7)) run.recordEvent(event);
    run.recordSplit(split('proposed'));
    run.beginSplit('T-1');
    run.recordSplit(split('fits'));

    const [proposed, fits] = lines<SplitRecord>(resolve(run.directory, 'splits.jsonl'));
    expect(proposed!.models?.['ollama/qwen3']).toMatchObject({ steps: 2, input: 17 });
    expect(fits!.models).toEqual({});
  });
});
