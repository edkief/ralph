import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isActivityEvent, type HarnessEvent } from '../src/harness/events.js';
import type { OpencodeFrame } from '../src/opencode/frames.js';
import { errorMessage, OpencodeTranslator } from '../src/opencode/translate.js';

const S = 'ses_1';

const frame = (type: string, data: Record<string, unknown> = {}, created?: number): OpencodeFrame => ({
  type,
  ...(created !== undefined ? { created } : {}),
  data,
});
const inSession = (type: string, data: Record<string, unknown> = {}, created?: number) =>
  frame(type, { sessionID: S, ...data }, created);

function translate(...frames: OpencodeFrame[]): HarnessEvent[] {
  const translator = new OpencodeTranslator();
  return frames.flatMap((next) => translator.push(next));
}

describe('OpencodeTranslator', () => {
  describe('sessions and prompts', () => {
    it('names the turn Ralph started, with its time', () => {
      expect(translate(frame('ralph.turn.started', { sessionID: S, continued: true }, 5))).toEqual([
        { type: 'turn.started', created: 5, session: S, continued: true },
      ]);
      expect(translate(frame('ralph.turn.started', { sessionID: S }))).toEqual([
        { type: 'turn.started', session: S, continued: false },
      ]);
    });

    it('carries the parent of a session when there is one', () => {
      expect(translate(inSession('session.created', { parentID: 'ses_0' }))).toEqual([
        { type: 'session.started', session: S, parent: 'ses_0' },
      ]);
      expect(translate(inSession('session.created'))).toEqual([{ type: 'session.started', session: S }]);
      expect(translate(frame('session.created', {}))).toEqual([]);
    });

    it('reads the prompt out of the inbox, and takes an empty one for plain activity', () => {
      const item = (text?: string) => ({ item: { type: 'user', payload: text === undefined ? {} : { text } } });
      expect(translate(inSession('session.inbox.enqueued', item('Do it')))).toEqual([
        { type: 'prompt.queued', session: S, text: 'Do it' },
      ]);
      expect(translate(inSession('session.inbox.enqueued', item()))).toEqual([{ type: 'activity', session: S }]);
    });
  });

  describe('text and reasoning', () => {
    const part = { assistantMessageID: 'msg_1', ordinal: 2 };

    it('names a part by its message and ordinal', () => {
      expect(translate(inSession('session.text.delta', { ...part, delta: 'Hel' }, 1))).toEqual([
        { type: 'text.delta', created: 1, session: S, part: 'msg_1:2', text: 'Hel' },
      ]);
      expect(translate(inSession('session.text.ended', { ...part, text: 'Hello' }))).toEqual([
        { type: 'text.ended', session: S, part: 'msg_1:2', text: 'Hello' },
      ]);
      expect(translate(inSession('session.reasoning.delta', { ...part, delta: 'hm' }))).toEqual([
        { type: 'reasoning.delta', session: S, part: 'msg_1:2', text: 'hm' },
      ]);
    });

    it('leaves the part out for servers that send no ids, and counts a missing ordinal as 0', () => {
      expect(translate(inSession('session.text.delta', { delta: 'x' }))).toEqual([{ type: 'text.delta', session: S, text: 'x' }]);
      expect(translate(inSession('session.text.ended', { assistantMessageID: 'm', text: 'x' }))).toEqual([
        { type: 'text.ended', session: S, part: 'm:0', text: 'x' },
      ]);
    });

    it('takes an empty delta for plain activity', () => {
      expect(translate(inSession('session.text.delta', { delta: '' }))).toEqual([{ type: 'activity', session: S }]);
    });

    it('omits the text of reasoning that is empty or encrypted', () => {
      expect(translate(inSession('session.reasoning.ended', { ...part, text: '', state: { reasoningEncryptedContent: 'abc' } }))).toEqual([
        { type: 'reasoning.ended', session: S, part: 'msg_1:2' },
      ]);
      expect(translate(inSession('session.reasoning.ended', { ...part, text: 'because' }))).toEqual([
        { type: 'reasoning.ended', session: S, part: 'msg_1:2', text: 'because' },
      ]);
    });
  });

  describe('tools', () => {
    it('gives a call the name its input started with, and its result too', () => {
      const events = translate(
        inSession('session.tool.input.started', { id: 'c1', name: 'bash' }),
        inSession('session.tool.called', { id: 'c1', input: { command: 'ls' } }),
        inSession('session.tool.success', {
          id: 'c1',
          content: [{ type: 'text', text: 'a.ts' }, { type: 'text', text: 'Command exited with code 0.' }],
          metadata: { exit: 0 },
        }),
      );
      expect(events).toEqual([
        { type: 'tool.started', session: S, id: 'c1', name: 'bash' },
        { type: 'tool.called', session: S, id: 'c1', name: 'bash', input: { command: 'ls' } },
        { type: 'tool.finished', session: S, id: 'c1', name: 'bash', status: 'success', exit: 0, output: 'a.ts\nCommand exited with code 0.' },
      ]);
    });

    it('does not mix up calls', () => {
      const events = translate(
        inSession('session.tool.input.started', { id: 'a', name: 'read' }),
        inSession('session.tool.input.started', { id: 'b', name: 'edit' }),
        inSession('session.tool.called', { id: 'a' }),
        inSession('session.tool.called', { id: 'b' }),
      );
      expect(events.filter((event) => event.type === 'tool.called').map((event) => event.name)).toEqual(['read', 'edit']);
    });

    it('falls back to a name the frame itself carries, and to none', () => {
      expect(translate(inSession('session.tool.called', { tool: 'shell' }))).toEqual([{ type: 'tool.called', session: S, name: 'shell' }]);
      expect(translate(inSession('session.tool.called', { name: 'x' }))).toEqual([{ type: 'tool.called', session: S, name: 'x' }]);
      expect(translate(inSession('session.tool.called', { id: 'z' }))).toEqual([{ type: 'tool.called', session: S, id: 'z' }]);
    });

    it('reports an error and a failure as errors, with no output when there is none', () => {
      expect(translate(inSession('session.tool.error', { id: 'c', content: [{ text: 'no match' }] }))).toEqual([
        { type: 'tool.finished', session: S, id: 'c', status: 'error', output: 'no match' },
      ]);
      expect(translate(inSession('session.tool.failed', { id: 'c' }))).toEqual([
        { type: 'tool.finished', session: S, id: 'c', status: 'error' },
      ]);
    });

    it('keeps a non-zero exit on a call that ran', () => {
      const [event] = translate(inSession('session.tool.success', { id: 'c', metadata: { exit: 2 } }));
      expect(event).toMatchObject({ status: 'success', exit: 2 });
    });

    it('takes a tool start with no id for plain activity', () => {
      expect(translate(inSession('session.tool.input.started', { name: 'bash' }))).toEqual([{ type: 'activity', session: S }]);
    });
  });

  describe('model calls', () => {
    it('names the model as provider/id', () => {
      expect(translate(inSession('session.step.started', { model: { id: 'qwen3', providerID: 'ollama' } }))).toEqual([
        { type: 'step.started', session: S, model: 'ollama/qwen3' },
      ]);
      expect(translate(inSession('session.step.started', { model: { id: 'qwen3' } }))).toEqual([
        { type: 'step.started', session: S, model: 'qwen3' },
      ]);
      expect(translate(inSession('session.step.started'))).toEqual([{ type: 'step.started', session: S }]);
    });

    it('marks the end of the stream', () => {
      expect(translate(inSession('session.step.streamed', {}, 9))).toEqual([{ type: 'step.streamed', created: 9, session: S }]);
    });

    it('maps the tokens, cache and cost of a step to the usage fields', () => {
      expect(
        translate(
          inSession('session.step.ended', {
            finish: 'tool-calls',
            cost: 0.25,
            tokens: { input: 10253, output: 69, reasoning: 29, cache: { read: 7, write: 3 } },
            files: ['a.ts'],
          }),
        ),
      ).toEqual([
        {
          type: 'step.ended',
          session: S,
          finish: 'tool-calls',
          usage: { input: 10253, output: 69, reasoning: 29, cacheRead: 7, cacheWrite: 3, cost: 0.25 },
          files: ['a.ts'],
        },
      ]);
    });

    it('counts a step that reports nothing as a step with no usage', () => {
      expect(translate(inSession('session.step.ended'))).toEqual([
        { type: 'step.ended', session: S, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      ]);
    });

    it('reads a failure in any of the shapes errors come in', () => {
      const failed = (error: unknown) => translate(inSession('session.step.failed', { error }));
      expect(failed({ type: 'x', message: 'prompt is too long' })).toEqual([{ type: 'step.failed', session: S, error: 'prompt is too long' }]);
      expect(failed({ name: 'APIError', data: { message: 'context window exceeds limit' } })).toEqual([
        { type: 'step.failed', session: S, error: 'context window exceeds limit' },
      ]);
      expect(failed('plain')).toEqual([{ type: 'step.failed', session: S, error: 'plain' }]);
      expect(failed(undefined)).toEqual([{ type: 'step.failed', session: S }]);
    });

    it('maps a provider retry, preferring the message to the type', () => {
      expect(
        translate(inSession('session.retry.scheduled', { attempt: 2, error: { type: 'provider.rate-limit', message: 'slow down', status: 429 } })),
      ).toEqual([{ type: 'retry', session: S, attempt: 2, error: 'slow down', status: 429 }]);
      expect(translate(inSession('session.retry.scheduled', { error: { type: 'provider.unavailable' } }))).toEqual([
        { type: 'retry', session: S, error: 'provider.unavailable' },
      ]);
      expect(translate(inSession('session.retry.scheduled'))).toEqual([{ type: 'retry', session: S }]);
    });
  });

  describe('compaction and execution', () => {
    it('maps compaction, a delta being compaction still going', () => {
      expect(
        translate(
          inSession('session.compaction.started'),
          inSession('session.compaction.delta', { delta: 's' }),
          inSession('session.compaction.ended', { text: 'summary' }),
        ).map((event) => event.type),
      ).toEqual(['compaction.started', 'compaction.progress', 'compaction.ended']);
    });

    it('maps how an execution ended, with the reason it failed', () => {
      expect(translate(inSession('session.execution.succeeded'))).toEqual([{ type: 'execution.ended', session: S, outcome: 'succeeded' }]);
      expect(translate(inSession('session.execution.aborted'))).toEqual([{ type: 'execution.ended', session: S, outcome: 'aborted' }]);
      expect(translate(inSession('session.execution.failed', { error: { name: 'E', data: { message: 'boom' } } }))).toEqual([
        { type: 'execution.ended', session: S, outcome: 'failed', error: 'boom' },
      ]);
    });
  });

  describe('forms and permissions', () => {
    it('opens a form in the session the form names', () => {
      const fields = [{ key: 'x', type: 'text' }];
      expect(
        translate(frame('form.created', { form: { id: 'f1', sessionID: S, title: 'Pick', metadata: { kind: 'question' }, fields } })),
      ).toEqual([{ type: 'form.opened', session: S, form: { id: 'f1', title: 'Pick', kind: 'question', fields } }]);
      expect(translate(frame('form.created', { form: { id: 'f1', sessionID: S } }))).toEqual([
        { type: 'form.opened', session: S, form: { id: 'f1' } },
      ]);
    });

    it('settles a form by how it ended', () => {
      expect(translate(frame('form.replied', { id: 'f1', sessionID: S }))).toEqual([
        { type: 'form.settled', session: S, id: 'f1', outcome: 'replied' },
      ]);
      expect(translate(frame('form.cancelled', { id: 'f1' }))).toEqual([{ type: 'form.settled', id: 'f1', outcome: 'cancelled' }]);
    });

    it('takes a form that does not parse for plain activity', () => {
      expect(translate(frame('form.created', { form: {} }))).toEqual([{ type: 'activity' }]);
    });

    it('reads a permission request whatever its frame is called', () => {
      const request = { id: 'p1', sessionID: S, action: 'edit', resources: ['a.ts'], message: 'May I?' };
      const expected = { type: 'permission.asked', session: S, id: 'p1', action: 'edit', resources: ['a.ts'], message: 'May I?' };
      expect(translate(frame('session.permission.requested', request))).toEqual([expected]);
      expect(translate(frame('permission.asked', request))).toEqual([expected]);
      expect(translate(frame('permission.asked', { id: 'p2', sessionID: S, action: 'bash' }))).toEqual([
        { type: 'permission.asked', session: S, id: 'p2', action: 'bash', resources: [] },
      ]);
    });

    it('takes other permission frames for plain activity', () => {
      expect(translate(frame('permission.replied', { sessionID: S, id: 'p1', reply: 'once' }))).toEqual([{ type: 'activity', session: S }]);
    });
  });

  describe('everything else', () => {
    it('turns a session frame with nothing to record into activity, keeping its time', () => {
      for (const type of ['session.execution.started', 'session.tool.progress', 'session.usage.updated', 'session.inbox.delivered']) {
        expect(translate(inSession(type))).toEqual([{ type: 'activity', session: S }]);
      }
      expect(translate(inSession('session.tool.progress', {}, 7))).toEqual([{ type: 'activity', created: 7, session: S }]);
      expect(translate(frame('session.weird.frame', {}))).toEqual([{ type: 'activity' }]);
    });

    it('drops what is not about a session', () => {
      for (const type of ['server.connected', 'mcp.status.changed', 'shell.created', 'shell.exited', 'worktree.resolved', 'provider.updated']) {
        expect(translate(frame(type, { sessionID: S }))).toEqual([]);
      }
    });

    it('copes with a frame that has no data at all', () => {
      expect(translate({ type: 'session.text.ended' })).toEqual([{ type: 'text.ended', text: '' }]);
      expect(translate({ type: 'session.tool.called' })).toEqual([{ type: 'tool.called' }]);
      expect(translate({ type: 'server.connected' })).toEqual([]);
    });
  });

  it('translates a real captured session', () => {
    const frames = readFileSync(resolve(__dirname, 'fixtures/session-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as OpencodeFrame);
    const events = translate(...frames);

    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'prompt.queued',
      'activity', // session.execution.started
      'activity', // session.instructions.updated
      'activity', // session.inbox.delivered
      'step.started',
      'retry',
      'step.started', // the call starts over after the retry
      'activity', // session.reasoning.started
      'reasoning.ended',
      'activity', // session.text.started
      'text.delta',
      'text.ended',
      'tool.started',
      'activity', // session.tool.input.ended
      'tool.called',
      'activity', // session.tool.progress
      'tool.finished',
      'step.streamed',
      'step.ended',
      'activity', // session.usage.updated
      'step.started',
      'activity',
      'reasoning.ended',
      'activity',
      'text.delta',
      'text.ended',
      'step.streamed',
      'step.ended',
    ]);
    const first = events.find((event) => event.type === 'step.ended');
    expect(first).toMatchObject({ usage: { input: 10253, output: 69, reasoning: 29, cacheRead: 0, cacheWrite: 0, cost: 0 } });
    expect(events.find((event) => event.type === 'tool.called')).toMatchObject({ name: 'shell', input: { command: 'echo capture-ok' } });
    expect(events.every((event) => event.created === undefined || typeof event.created === 'number')).toBe(true);
  });
});

describe('isActivityEvent', () => {
  it('lets everything the agent does reset the watchdog but provider retries and bookkeeping', () => {
    const quiet = ['retry', 'session.started', 'turn.started', 'form.opened', 'form.settled'];
    const events: HarnessEvent[] = [
      { type: 'retry' },
      { type: 'session.started', session: S },
      { type: 'turn.started', session: S, continued: false },
      { type: 'form.opened', session: S, form: { id: 'f' } },
      { type: 'form.settled', id: 'f', outcome: 'replied' },
      { type: 'activity' },
      { type: 'text.delta', text: 'x' },
      { type: 'step.started' },
      { type: 'compaction.progress' },
      { type: 'permission.asked', session: S, id: 'p', action: 'edit', resources: [] },
      { type: 'execution.ended', outcome: 'succeeded' },
    ];
    expect(events.filter((event) => !isActivityEvent(event)).map((event) => event.type)).toEqual(quiet);
  });
});

describe('errorMessage', () => {
  it('reads the shapes errors come in', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ message: 'a' })).toBe('a');
    expect(errorMessage({ data: { message: 'b' } })).toBe('b');
    expect(errorMessage({ name: 'c' })).toBe('c');
    expect(errorMessage({ type: 'd' })).toBe('d');
    expect(errorMessage('')).toBeUndefined();
    expect(errorMessage(undefined)).toBeUndefined();
    expect(errorMessage(3)).toBeUndefined();
  });
});
