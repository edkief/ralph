import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageMeter, usageOfEventsFile, totalTokens } from '../src/metrics/usage.js';

const FIXTURE = resolve(__dirname, 'fixtures/session-events.jsonl');
const MODEL = 'opencode/muse-spark-1.3-contributor-free';

const event = (type: string, created: number, data: Record<string, unknown> = {}) => ({
  type,
  created,
  data: { sessionID: 's', ...data },
});
const started = (created: number, id = 'qwen3', sessionID = 's') =>
  event('session.step.started', created, { sessionID, model: { id, providerID: 'ollama' } });
const ended = (created: number, input: number, output: number, sessionID = 's') =>
  event('session.step.ended', created, { sessionID, tokens: { input, output, reasoning: 0, cache: { read: 5, write: 2 } } });

describe('UsageMeter', () => {
  it('totals a real captured session by model, with its inference time', () => {
    const usage = usageOfEventsFile(FIXTURE);
    expect(Object.keys(usage)).toEqual([MODEL]);
    const model = usage[MODEL]!;
    expect(model).toMatchObject({ steps: 2, input: 10253 + 158, output: 69 + 21, reasoning: 29 + 16, cacheRead: 10225 });
    // Step 1: restarted at 246785 after a retry, streamed at 246829, with a tool
    // running 246797–246822. Step 2: 248361 to its stream's end at 248494.
    expect(model.inferenceMs).toBe(44 - 25 + 133);
  });

  it('times a step to its end when it reports no stream end', () => {
    const meter = new UsageMeter();
    meter.push(started(1_000));
    meter.push(ended(4_000, 100, 10));
    const usage = meter.drain()['ollama/qwen3']!;
    expect(usage).toMatchObject({ steps: 1, input: 100, output: 10, cacheRead: 5, cacheWrite: 2, inferenceMs: 3_000 });
    expect(totalTokens(usage)).toBe(117);
  });

  it('keeps sessions apart, so a subagent on another model is attributed to it', () => {
    const meter = new UsageMeter();
    meter.push(started(0, 'big'));
    meter.push(started(100, 'small', 'child'));
    meter.push(ended(600, 1, 1, 'child'));
    meter.push(ended(1_000, 2, 2));
    const usage = meter.drain();
    expect(usage['ollama/big']).toMatchObject({ input: 2, inferenceMs: 1_000 });
    expect(usage['ollama/small']).toMatchObject({ input: 1, inferenceMs: 500 });
  });

  it('counts the time of a failed call, and tokens of a call whose start it missed', () => {
    const meter = new UsageMeter();
    meter.push(started(0));
    meter.push(event('session.step.failed', 700));
    meter.push(ended(900, 3, 3));
    expect(meter.drain()['ollama/qwen3']).toMatchObject({ steps: 1, input: 3, inferenceMs: 700 });

    meter.push(ended(10, 4, 4, 'other'));
    expect(meter.drain()).toEqual({ unknown: expect.objectContaining({ steps: 1, input: 4, inferenceMs: 0 }) });
  });

  it('starts over after a drain', () => {
    const meter = new UsageMeter();
    meter.push(started(0));
    meter.push(ended(10, 1, 1));
    meter.drain();
    expect(meter.drain()).toEqual({});
  });
});
