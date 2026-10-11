import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { runIteration } from '../src/loop/iteration.js';
import type { FakePiOptions } from './helpers/pi.js';
import { piRig, quietLogger, type PiRig } from './helpers/pi-harness.js';

/**
 * The loop's own turn, over a pi harness over a fake pi that replays sessions recorded from pi 1.1.0: what
 * the watchdog, the wrap-up, the retry count and the overflow check do with pi's events.
 */
const rigs: PiRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((made) => made.close()));
});

async function iterate(
  fake: FakePiOptions,
  overrides: Record<string, unknown> = {},
  extra: Partial<Parameters<typeof runIteration>[0]> = {},
) {
  const made = await piRig(fake);
  rigs.push(made);
  const config: Config = ConfigSchema.parse({ ...made.config, ...overrides, harness: 'pi', pi: made.config.pi });
  const result = await runIteration({
    harness: made.harness,
    config,
    prompt: 'do the thing',
    title: 'test',
    logger: quietLogger,
    signal: new AbortController().signal,
    ...extra,
  });
  return { result, made };
}

const wrapUp = { prompt: (trigger: string) => `Time is up (${trigger}), hand off.` };
const types = (made: PiRig) => made.fake.commands().map((command) => command['type']);
const sent = (made: PiRig, type: string) => made.fake.commands().filter((command) => command['type'] === type);

describe('a pi turn through the loop', () => {
  it('collects the text, the tool calls, the tokens and the end of a finished turn', async () => {
    const { result, made } = await iterate({ captures: ['tool-turn'] }, { model: 'stub/stub-model' });

    expect(result.status).toBe('complete');
    expect(result.tags.complete).toBe(true);
    expect(result.toolCalls).toBe(1);
    // What pi reported for the two model calls: input without the cached part, thinking inside output.
    expect(result.usage).toEqual({ input: 1134 + 1400, output: 56 + 9, reasoning: 0, cacheRead: 100, cacheWrite: 0, cost: 0 });
    expect(result.text).toContain('Running a command.');
    expect(types(made)).toEqual(expect.arrayContaining(['get_state', 'prompt']));
  });

  it('asks for the model the config names, before the prompt', async () => {
    const { made } = await iterate({ captures: ['tool-turn'] }, { model: 'stub/stub-model' });
    // The session already runs on it (the fake starts on none, as a pi with no default would), so the switch is the first thing.
    expect(sent(made, 'set_model')).toEqual([expect.objectContaining({ provider: 'stub', modelId: 'stub-model' })]);
    expect(types(made).indexOf('set_model')).toBeLessThan(types(made).indexOf('prompt'));
  });
});

describe('wrap-up steering', () => {
  it('steers a working agent into the wrap-up when the iteration runs out of time, without stopping its tool', async () => {
    const { result, made } = await iterate(
      { captures: ['steer'] },
      { timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } },
      { wrapUp },
    );

    expect(result.status).toBe('wrapped-up');
    expect(result.wrapUp).toMatchObject({ trigger: 'iteration-timeout', delivery: 'steer', completed: true });
    expect(result.error).toMatch(/^Iteration exceeded/);
    expect(sent(made, 'steer')).toEqual([expect.objectContaining({ message: 'Time is up (iteration-timeout), hand off.' })]);
    expect(sent(made, 'abort')).toHaveLength(0);
    // One prompt, then the steer: nothing else was sent to the model.
    expect(sent(made, 'prompt')).toHaveLength(1);
  });

  it('interrupts a quiet agent first, since a steer waits for the tool it is stuck in, then prompts the wrap-up', async () => {
    const { result, made } = await iterate(
      { captures: ['abort', 'tool-turn'] },
      { timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 5_000 } },
      { wrapUp },
    );

    expect(result.status).toBe('wrapped-up');
    expect(result.wrapUp).toMatchObject({ trigger: 'inactivity', delivery: 'interrupt', completed: true });
    expect(types(made).filter((type) => ['prompt', 'steer', 'abort'].includes(String(type)))).toEqual(['prompt', 'abort', 'prompt']);
    expect(sent(made, 'prompt')[1]).toMatchObject({ message: 'Time is up (inactivity), hand off.' });
  });
});

describe('the inactivity watchdog', () => {
  it('times out an agent that goes quiet, and stops it', async () => {
    const { result, made } = await iterate(
      { captures: ['abort'] },
      { timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 0 } },
    );

    expect(result.status).toBe('timeout');
    expect(result.trip).toBe('inactivity');
    expect(result.error).toMatch(/No activity from the agent for 1s/);
    expect(sent(made, 'abort')).toHaveLength(1);
  });
});

/** The error the stub's 500 reaches the agent as. */
const OVERLOADED = '500: {"message":"stub overloaded","type":"server_error"}';

describe('provider retries', () => {
  it('counts the retries pi makes, reports the error, and treats giving up as a provider error', async () => {
    const attempts: Array<[number, string]> = [];
    const { result } = await iterate(
      { captures: ['retry'] },
      {},
      { hooks: { onRetry: (attempt, message) => attempts.push([attempt, message]) } },
    );

    // pi 1.x gives the provider's error as `<status>: <its error object>`.
    expect(attempts).toEqual([
      [1, OVERLOADED],
      [2, OVERLOADED],
      [3, OVERLOADED],
    ]);
    expect(result.lastProviderError).toBe(OVERLOADED);
    expect(result.error).toBe(OVERLOADED);
    // The orchestrator backs off on this status.
    expect(result.status).toBe('provider-error');
  });

  it('trips the retry-storm check while pi is still retrying, and stops it', async () => {
    const { result, made } = await iterate(
      { captures: ['retry', 'abort'], scale: 0.2 },
      { retries: { providerRetriesPerIteration: 1 }, timeouts: { inactivityMs: 60_000 } },
    );

    expect(result.status).toBe('provider-error');
    expect(result.trip).toBe('retry-storm');
    expect(result.lastProviderError).toBe(OVERLOADED);
    expect(sent(made, 'abort')).toHaveLength(1);
  });
});

describe('context overflow', () => {
  it('reports an overflow pi could not recover from, so the loop can start the task over smaller', async () => {
    // The recording opens with a turn that gives pi a history to compact.
    const { result } = await iterate({ captures: ['overflow'], skip: 1 });

    expect(result.status).toBe('context-overflow');
    expect(result.error).toMatch(/maximum context length is 4096 tokens/);
  });

  it('counts a compaction pi recovered an overflow with, and carries on to the end of the turn', async () => {
    const { result } = await iterate({ captures: ['overflow-recovered'], skip: 1 });

    expect(result.compactions).toBe(1);
    expect(result.status).toBe('complete');
    expect(result.error).toBeUndefined();
  });

  it('reports an overflow pi had nothing to compact for as an overflow', async () => {
    const { result } = await iterate({ captures: ['overflow-nothing-to-compact'] });

    expect(result.status).toBe('context-overflow');
    expect(result.error).toMatch(/maximum context length is 4096 tokens/);
  });
});
