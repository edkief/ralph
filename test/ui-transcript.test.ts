import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptBuilder } from '../src/ui/transcript.js';
import type { OpencodeEvent } from '../src/opencode/events.js';

const fixture = readFileSync(resolve(__dirname, 'fixtures/session-events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as OpencodeEvent);

function build(events: OpencodeEvent[]) {
  const builder = new TranscriptBuilder();
  for (const event of events) builder.push(event);
  return builder.all;
}

describe('TranscriptBuilder', () => {
  it('reads a real captured session', () => {
    const entries = build(fixture);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'prompt',
      'notice', // provider retry
      'text',
      'tool',
      'step',
      'text',
      'step',
    ]);
    expect(entries[0]).toMatchObject({ kind: 'prompt', text: expect.stringContaining("echo capture-ok") });
    expect(entries[1]).toMatchObject({ kind: 'notice', level: 'warn', text: expect.stringContaining('provider retry 2') });
    expect(entries[2]).toMatchObject({ kind: 'text', text: 'Executing shell command, then final marker.', done: true });
    expect(entries[3]).toMatchObject({
      kind: 'tool',
      name: 'shell',
      input: { command: 'echo capture-ok' },
      status: 'success',
      exit: 0,
      output: 'capture-ok\n\nCommand exited with code 0.',
    });
    expect(entries[4]).toMatchObject({ kind: 'step', finish: 'tool-calls', tokens: { input: 10253, output: 69 } });
    expect(entries[5]).toMatchObject({ kind: 'text', text: '<promise>TASK-99:DONE</promise>' });
    expect(entries[6]).toMatchObject({ kind: 'step', tokens: { cacheRead: 10225 } });
    // Encrypted reasoning has no text to show.
    expect(entries.some((entry) => entry.kind === 'reasoning')).toBe(false);
  });

  it('grows a text part delta by delta under one id', () => {
    const builder = new TranscriptBuilder();
    const part = { sessionID: 's', assistantMessageID: 'm', ordinal: 0 };
    const [first] = builder.push({ type: 'session.text.delta', data: { ...part, delta: 'Hel' } });
    const [second] = builder.push({ type: 'session.text.delta', data: { ...part, delta: 'lo' } });
    const [ended] = builder.push({ type: 'session.text.ended', data: { ...part, text: 'Hello' } });

    expect(first).toMatchObject({ text: 'Hel', done: false });
    expect(second).toMatchObject({ id: first!.id, text: 'Hello', done: false });
    expect(ended).toMatchObject({ id: first!.id, text: 'Hello', done: true });
    expect(builder.all).toHaveLength(1);
  });

  it('keeps parts without ids apart', () => {
    const entries = build([
      { type: 'session.text.ended', data: { text: 'one' } },
      { type: 'session.text.delta', data: { delta: 'tw' } },
      { type: 'session.text.ended', data: { text: 'two' } },
    ]);
    expect(entries.map((entry) => (entry.kind === 'text' ? entry.text : ''))).toEqual(['one', 'two']);
  });

  it('marks a failed tool and a subagent’s work', () => {
    const entries = build([
      { type: 'session.created', data: { sessionID: 'main' } },
      { type: 'session.created', data: { sessionID: 'child', parentID: 'main' } },
      { type: 'session.tool.input.started', data: { sessionID: 'child', id: 'c1', name: 'shell' } },
      {
        type: 'session.tool.success',
        data: { sessionID: 'child', id: 'c1', content: [{ text: 'boom' }], metadata: { exit: 2 } },
      },
      { type: 'session.execution.failed', data: { sessionID: 'main', error: { message: 'prompt is too long' } } },
    ]);

    expect(entries[0]).toMatchObject({ kind: 'tool', status: 'error', exit: 2, subagent: true });
    expect(entries[1]).toMatchObject({ kind: 'notice', level: 'error', text: 'prompt is too long' });
    expect(entries[1]).not.toHaveProperty('subagent');
  });

  it('clips long text, reasoning, prompts and tool input', () => {
    const long = 'x'.repeat(150_000);
    const entries = build([
      { type: 'session.inbox.enqueued', data: { sessionID: 's', item: { payload: { text: long } } } },
      { type: 'session.text.ended', data: { sessionID: 's', text: long } },
      { type: 'session.reasoning.ended', data: { sessionID: 's', text: long } },
      { type: 'session.tool.called', data: { sessionID: 's', id: 't1', input: { filePath: 'a.ts', content: long, edits: [long] } } },
    ]);

    for (const entry of entries.slice(0, 3)) {
      const text = (entry as { text: string }).text;
      expect(text.length).toBeLessThan(100_100);
      expect(text).toMatch(/… \(50000 more characters\)$/);
    }
    const input = (entries[3] as { input: Record<string, string> }).input;
    expect(input['filePath']).toBe('a.ts');
    expect(input['content']!.length).toBeLessThan(20_100);
    expect(input['content']).toMatch(/more characters\)$/);
    expect(typeof input['edits']).toBe('string');
    expect(input['edits']!.length).toBeLessThan(20_100);
  });

  it('stops a text part growing once it is full', () => {
    const builder = new TranscriptBuilder();
    const delta = { type: 'session.text.delta', data: { sessionID: 's', delta: 'y'.repeat(60_000) } };
    expect(builder.push(delta)).toHaveLength(1);
    expect(builder.push(delta)).toHaveLength(1);
    expect(builder.push(delta)).toEqual([]);
    expect((builder.all[0] as { text: string }).text).toHaveLength(120_000);
  });
});

describe('a long session', () => {
  it('keeps every entry', () => {
    const builder = new TranscriptBuilder();
    for (let index = 0; index < 5000; index += 1) {
      builder.push({ type: 'session.text.ended', data: { sessionID: 's', text: `message ${index}` } });
    }
    const all = builder.all;
    expect(all).toHaveLength(5000);
    expect(all[0]).toMatchObject({ text: 'message 0' });
    expect(all.at(-1)).toMatchObject({ text: 'message 4999' });
  });
});
