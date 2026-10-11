import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarnessEventSchema, isActivityEvent, type EventOf, type HarnessEvent } from '../src/harness/events.js';
import { isContextOverflow } from '../src/harness/overflow.js';
import { FrameSchema } from '../src/pi/frames.js';
import { PiTranslator } from '../src/pi/translate.js';

/** The frames pi wrote in a recorded session, in order. */
function frames(name: string) {
  return readFileSync(resolve(__dirname, `fixtures/pi/${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; line: Record<string, unknown> })
    .filter((record) => record.dir === 'out' && record.line['type'] !== 'response')
    .map((record) => FrameSchema.parse(record.line));
}

/** A recorded session translated, with the end of the turn settled once nothing follows it. */
function translate(name: string): HarnessEvent[] {
  const translator = new PiTranslator('s1', { now: () => 1000 });
  const events = frames(name).flatMap((frame) => translator.push(frame));
  if (translator.settleDelay() !== undefined) events.push(...translator.settle());
  return events;
}

const ofType = <T extends HarnessEvent['type']>(events: HarnessEvent[], type: T) =>
  events.filter((event): event is EventOf<T> => event.type === type);
const types = (events: HarnessEvent[]) => events.map((event) => event.type);

describe('pi translation: a turn with a tool call', () => {
  const events = translate('tool-turn');

  it('yields only events in the vocabulary, each tagged with its session', () => {
    for (const event of events) {
      expect(HarnessEventSchema.safeParse(event).success).toBe(true);
      expect(event.session).toBe('s1');
      expect(event.created).toBe(1000);
    }
  });

  it('follows the turn as pi ran it: the model call ends before the tool it asked for runs', () => {
    expect(types(events).filter((type) => type !== 'activity' && !type.endsWith('.delta'))).toEqual([
      'prompt.queued',
      'step.started',
      'tool.started',
      'reasoning.ended',
      'text.ended',
      'step.streamed',
      'step.ended',
      'tool.called',
      'tool.finished',
      'step.started',
      'text.ended',
      'step.streamed',
      'step.ended',
      'execution.ended',
    ]);
    expect(ofType(events, 'prompt.queued')[0]).toMatchObject({ text: 'Run echo hello then finish.' });
    expect(ofType(events, 'step.started')[0]).toMatchObject({ model: 'stub/stub-model' });
  });

  it('keeps the deltas and the end of a block under one part id', () => {
    const [delta] = ofType(events, 'text.delta');
    const [ended] = ofType(events, 'text.ended');
    expect(delta?.part).toBeDefined();
    expect(delta?.part).toBe(ended?.part);
    expect(ended?.text).toBe('Running a command. ');
    expect(ofType(events, 'reasoning.ended')[0]).toMatchObject({ text: 'I should run echo.' });
  });

  it('names the tool by the id its call started with, and reports its input and output', () => {
    expect(ofType(events, 'tool.started')[0]).toMatchObject({ id: 'call_1', name: 'bash' });
    expect(ofType(events, 'tool.called')[0]).toMatchObject({
      id: 'call_1',
      name: 'bash',
      input: { command: 'echo hello && echo oops >&2; exit 3' },
    });
    expect(ofType(events, 'tool.finished')[0]).toMatchObject({ id: 'call_1', name: 'bash' });
  });

  it('reads a bash exit code from the last line of its output: it ran, so it succeeded, with its exit', () => {
    const [finished] = ofType(events, 'tool.finished');
    expect(finished).toMatchObject({ status: 'success', exit: 3 });
    expect(finished?.output).toContain('hello');
    expect(finished?.output).toMatch(/Command exited with code 3$/);
  });

  it('reports usage as pi counts it: input without the cached part, thinking inside output', () => {
    const steps = ofType(events, 'step.ended');
    // The stub sent prompt_tokens 1234 of which 100 cached, and completion_tokens 56 of which 12 reasoning.
    expect(steps[0]?.usage).toEqual({ input: 1134, output: 56, reasoning: 0, cacheRead: 100, cacheWrite: 0, cost: 0 });
    expect(steps[1]?.usage).toMatchObject({ input: 1400, output: 9 });
    expect(steps.map((step) => step.finish)).toEqual(['tool-calls', 'stop']);
  });

  it('ends the execution as succeeded', () => {
    expect(ofType(events, 'execution.ended')).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
    expect(events.at(-1)?.type).toBe('execution.ended');
  });
});

describe('pi translation: the end of a turn', () => {
  it('is not settled by an agent_end that retrying follows, nor does it show the attempts that fail', () => {
    const events = translate('retry');
    expect(ofType(events, 'retry')).toEqual([
      expect.objectContaining({ attempt: 1, status: 500, error: '500 stub overloaded' }),
      expect.objectContaining({ attempt: 2, status: 500 }),
      expect.objectContaining({ attempt: 3, status: 500 }),
    ]);
    // Only the last failure is a failed call; the others are the retries.
    expect(ofType(events, 'step.failed')).toEqual([expect.objectContaining({ error: '500 stub overloaded' })]);
    expect(ofType(events, 'execution.ended')).toEqual([
      expect.objectContaining({ outcome: 'failed', error: '500 stub overloaded' }),
    ]);
  });

  it('shows the watchdog nothing but retries between one failed attempt and the next', () => {
    const events = translate('retry');
    const firstRetry = events.findIndex((event) => event.type === 'retry');
    const between = events.slice(firstRetry + 1, events.findLastIndex((event) => event.type === 'retry'));
    expect(between.filter(isActivityEvent)).toEqual([]);
  });

  it('settles an overflow that pi could not recover from as failed, with the provider\'s own error', () => {
    const events = translate('overflow');
    const [ended] = ofType(events, 'execution.ended');
    expect(ended).toMatchObject({ outcome: 'failed' });
    expect(isContextOverflow(ended?.error ?? '')).toBe(true);
    expect(ofType(events, 'step.failed')).toHaveLength(1);
    expect(ofType(events, 'compaction.started')).toHaveLength(1);
    // The compaction failed: it is not a compaction.
    expect(ofType(events, 'compaction.ended')).toHaveLength(0);
  });

  it('carries on through a compaction that recovers an overflow, and ends once', () => {
    const events = translate('overflow-recovered');
    expect(types(events).filter((type) => type.startsWith('compaction'))).toEqual(['compaction.started', 'compaction.ended']);
    expect(ofType(events, 'step.failed')).toHaveLength(1);
    expect(ofType(events, 'execution.ended')).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
    expect(events.at(-1)?.type).toBe('execution.ended');
  });

  it('settles an aborted turn as aborted, with no failed call and no tokens', () => {
    const events = translate('abort');
    expect(ofType(events, 'execution.ended')).toEqual([expect.objectContaining({ outcome: 'aborted' })]);
    expect(ofType(events, 'step.failed')).toHaveLength(0);
    expect(ofType(events, 'step.ended')).toHaveLength(1);
    // The tool was cut short.
    expect(ofType(events, 'tool.finished')[0]).toMatchObject({ status: 'error' });
  });

  it('does not end a turn for a compaction that runs after it, and counts that compaction', () => {
    const events = translate('compact');
    expect(ofType(events, 'execution.ended')).toHaveLength(1);
    expect(types(events).slice(-2)).toEqual(['compaction.started', 'compaction.ended']);
  });

  it('settles a steered turn once, after the steer has been read', () => {
    const events = translate('steer');
    expect(ofType(events, 'prompt.queued').map((event) => event.text)).toEqual(['Run the slow thing.', 'Wrap up now.']);
    expect(ofType(events, 'execution.ended')).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
  });
});

describe('pi translation: settling', () => {
  const frame = (value: Record<string, unknown>) => FrameSchema.parse(value);

  it('waits for what may follow an erroring agent_end, and for nothing after a clean one', () => {
    const translator = new PiTranslator('s', { graceMs: 123 });
    translator.push(frame({ type: 'agent_start' }));
    translator.push(frame({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'boom' } }));
    expect(translator.push(frame({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom' }] }))).toEqual([]);
    expect(translator.running).toBe(true);
    expect(translator.settleDelay()).toBe(123);

    const clean = new PiTranslator('s');
    clean.push(frame({ type: 'agent_start' }));
    const events = clean.push(frame({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] }));
    expect(types(events)).toEqual(['execution.ended']);
    expect(clean.running).toBe(false);
    expect(clean.settleDelay()).toBeUndefined();
  });

  it('waits out a retry delay and then for the run that follows it', () => {
    const translator = new PiTranslator('s', { rerunWaitMs: 1000 });
    translator.push(frame({ type: 'agent_start' }));
    translator.push(frame({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '503' }] }));
    translator.push(frame({ type: 'auto_retry_start', attempt: 1, delayMs: 2000, errorMessage: '503 unavailable' }));
    expect(translator.settleDelay()).toBe(3000);
    translator.push(frame({ type: 'agent_start' }));
    expect(translator.settleDelay()).toBeUndefined();
    expect(translator.running).toBe(true);
  });

  it('ends a running turn as failed when the process dies', () => {
    const translator = new PiTranslator('s');
    translator.push(frame({ type: 'agent_start' }));
    expect(translator.exited('pi exited (code 1)')).toEqual([
      expect.objectContaining({ type: 'execution.ended', outcome: 'failed', error: 'pi exited (code 1)' }),
    ]);
    expect(translator.exited('again')).toEqual([]);
  });

  it('tells the files a turn wrote to the model call that follows them', () => {
    const translator = new PiTranslator('s');
    const events = [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'write', args: { path: 'src/a.ts' } },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'write', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'edit', args: { path: 'src/b.ts' } },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'edit', result: { content: [] }, isError: true },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 2, cost: { total: 0.5 } } } },
    ].flatMap((value) => translator.push(frame(value)));
    expect(ofType(events, 'step.ended')[0]).toMatchObject({ files: ['src/a.ts'], usage: { cost: 0.5 } });
  });
});
