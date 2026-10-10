import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer } from './helpers/fake-server.js';
import { OpencodeClient } from '../src/opencode/client.js';
import { FORM_CANCEL_MESSAGE, FORM_EXPIRED_MESSAGE, joinTurns, runIteration, type IterationResult } from '../src/loop/iteration.js';
import { fileAskRelay, type AskRelay, type FormOutcome } from '../src/loop/asks.js';
import { listAsks, readAsk, writeAskAnswer } from '../src/human/asks.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeEvent } from '../src/opencode/events.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { Logger } from '../src/report/logger.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WritableStream });

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function config(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ projectRoot: process.cwd(), ...overrides });
}

async function iterate(
  scenario: Parameters<typeof startFakeServer>[0],
  cfg: Config,
  extra: Pick<Parameters<typeof runIteration>[0], 'sessionId' | 'permissions' | 'formMessage' | 'asks' | 'wrapUp' | 'park' | 'hooks' | 'iterationMs'> = {},
) {
  server = await startFakeServer(scenario);
  const client = new OpencodeClient({
    baseUrl: server.url,
    ...(server.password ? { password: server.password } : {}),
  });
  return runIteration({
    client,
    config: cfg,
    prompt: 'do the thing',
    title: 'test',
    logger,
    signal: new AbortController().signal,
    ...extra,
  });
}

describe('runIteration', () => {
  it('collects text, tools and usage from a successful turn', async () => {
    const result = await iterate(
      {
        script: [
          { type: 'session.text.ended', data: { text: 'Working on it.' } },
          { type: 'session.tool.called', data: { tool: 'shell', input: { command: 'npm test' } } },
          { type: 'session.tool.success', data: { id: 'call_1' } },
          {
            type: 'session.step.ended',
            data: { finish: 'stop', cost: 0.5, tokens: { input: 100, output: 20 }, files: ['a.ts'] },
          },
          { type: 'session.text.ended', data: { text: '<promise>TASK-1:DONE</promise>' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('progressed');
    expect(result.tags.completedTaskIds).toEqual(['TASK-1']);
    expect(result.toolCalls).toBe(1);
    expect(result.usage.input).toBe(100);
    expect(result.usage.cost).toBe(0.5);
    expect(result.filesTouched).toEqual(['a.ts']);
  });

  it('names tools by correlating input.started with tool.called', async () => {
    const seen: string[] = [];
    server = await startFakeServer({
      script: [
        { type: 'session.tool.input.started', data: { id: 'call_1', name: 'shell' } },
        { type: 'session.tool.called', data: { id: 'call_1', input: { command: 'npm test' } } },
        { type: 'session.execution.succeeded' },
      ],
    });
    const client = new OpencodeClient({ baseUrl: server.url });
    await runIteration({
      client,
      config: config(),
      prompt: 'p',
      title: 't',
      logger,
      signal: new AbortController().signal,
      hooks: { onTool: (tool, detail) => seen.push(`${tool} ${detail}`) },
    });

    expect(seen).toEqual(['shell npm test']);
  });

  it('reports blocked and decide turns', async () => {
    const blocked = await iterate(
      {
        script: [
          { type: 'session.text.ended', data: { text: '<promise>BLOCKED:no credentials</promise>' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.tags.blockedReason).toBe('no credentials');
  });

  it('classifies a retry storm as a provider error and interrupts the session', async () => {
    const retry = (attempt: number) => ({
      type: 'session.retry.scheduled',
      data: { attempt, error: { type: 'provider.connection', message: 'ECONNREFUSED', status: 502 } },
      after: 10,
    });

    const result = await iterate(
      { script: [retry(1), retry(2), retry(3), retry(4), { after: 5_000, type: 'session.execution.succeeded' }] },
      config({ retries: { providerRetriesPerIteration: 2 }, timeouts: { inactivityMs: 60_000 } }),
    );

    expect(result.status).toBe('provider-error');
    expect(result.lastProviderError).toContain('ECONNREFUSED');
    expect(server?.interrupts).toBe(1);
  });

  it('times out a silent agent instead of hanging forever', async () => {
    const result = await iterate(
      { script: [{ after: 30_000, type: 'session.execution.succeeded' }] },
      config({ timeouts: { inactivityMs: 1_200, iterationMs: 60_000 } }),
    );

    expect(result.status).toBe('timeout');
    expect(result.error).toMatch(/No activity/);
    expect(server?.interrupts).toBe(1);
  });

  it('gives a turn the working time it is given, rather than a whole iteration', async () => {
    const result = await iterate(
      { script: [{ after: 30_000, type: 'session.execution.succeeded' }] },
      config({ timeouts: { inactivityMs: 60_000, iterationMs: 60 * 60_000, wrapUpMs: 0 } }),
      { iterationMs: 1_200 },
    );

    expect(result.status).toBe('timeout');
    expect(result.error).toMatch(/1s budget/);
  });

  it('waits out a compaction that is quieter than the inactivity window', async () => {
    const result = await iterate(
      {
        script: [
          { type: 'session.compaction.started', data: { reason: 'auto' } },
          { after: 2_500, type: 'session.compaction.ended', data: { reason: 'auto', text: 'summary', recent: '' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config({ timeouts: { inactivityMs: 1_200, iterationMs: 60_000 } }),
    );

    expect(result.status).toBe('progressed');
    expect(result.compactions).toBe(1);
    expect(server?.interrupts).toBe(0);
  });

  it('treats any session event as activity, such as a model still processing the prompt', async () => {
    const result = await iterate(
      {
        script: [
          { after: 700, type: 'session.step.started' },
          { after: 700, type: 'session.step.started' },
          { after: 700, type: 'session.execution.succeeded' },
        ],
      },
      config({ timeouts: { inactivityMs: 1_200, iterationMs: 60_000 } }),
    );

    expect(result.status).toBe('progressed');
  });

  it('keeps the iteration alive while a subagent works, without taking its output', async () => {
    const child = (type: string, data: Record<string, unknown> = {}) => ({
      after: 700,
      type,
      data: { sessionID: 'ses_child', ...data },
    });
    const result = await iterate(
      {
        script: [
          { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_fake_1' } },
          child('session.text.ended', { text: '<promise>COMPLETE</promise>' }),
          child('session.permission.requested', {
            id: 'per_child',
            action: 'shell',
            resources: ['npm test'],
          }),
          child('session.execution.succeeded'),
          { after: 700, type: 'session.text.ended', data: { text: 'mine' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config({ timeouts: { inactivityMs: 1_200, iterationMs: 60_000 } }),
    );

    expect(result.status).toBe('progressed');
    expect(result.text).toBe('mine');
    expect(server?.replies).toEqual([{ requestID: 'per_child', reply: 'once' }]);
  });

  it('interrupts the session when the turn is stopped from outside, as the server may outlive it', async () => {
    server = await startFakeServer({ script: [{ after: 30_000, type: 'session.execution.succeeded' }] });
    const client = new OpencodeClient({ baseUrl: server.url });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const result = await runIteration({ client, config: config(), prompt: 'do the thing', title: 'test', logger, signal: stop.signal });

    expect(result.status).toBe('interrupted');
    expect(server.interrupted).toEqual(['ses_fake_1']);
  });

  it('interrupts the subagents a stopped turn started, too', async () => {
    server = await startFakeServer({
      script: [
        { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_fake_1' } },
        { after: 30_000, type: 'session.execution.succeeded' },
      ],
    });
    const client = new OpencodeClient({ baseUrl: server.url });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    await runIteration({ client, config: config(), prompt: 'do the thing', title: 'test', logger, signal: stop.signal });

    expect([...server.interrupted].sort()).toEqual(['ses_child', 'ses_fake_1']);
  });

  it('does not interrupt a turn whose execution ended on its own', async () => {
    await iterate({ script: [{ type: 'session.execution.succeeded' }] }, config());

    expect(server?.interrupts).toBe(0);
  });

  it('finds a subagent by looking up its session when the event omits the parent', async () => {
    const seen: string[] = [];
    server = await startFakeServer({
      sessions: { ses_child: { parentID: 'ses_fake_1' }, ses_stranger: {} },
      script: [
        { type: 'session.created', data: { sessionID: 'ses_stranger' } },
        { type: 'session.created', data: { sessionID: 'ses_child' } },
        { after: 700, type: 'session.step.started', data: { sessionID: 'ses_child' } },
        { after: 700, type: 'session.step.started', data: { sessionID: 'ses_child' } },
        { type: 'session.step.started', data: { sessionID: 'ses_stranger' } },
        { after: 700, type: 'session.execution.succeeded' },
      ],
    });
    const client = new OpencodeClient({ baseUrl: server.url });
    const result = await runIteration({
      client,
      config: config({ timeouts: { inactivityMs: 1_200, iterationMs: 60_000 } }),
      prompt: 'p',
      title: 't',
      logger,
      signal: new AbortController().signal,
      hooks: {
        onEvent: (event) =>
          seen.push(`${event.type}:${(event.data as { sessionID: string }).sessionID}`),
      },
    });

    expect(result.status).toBe('progressed');
    // The turn names its own session before any of the stream's events.
    expect(seen[0]).toBe('ralph.turn.started:ses_fake_1');
    expect(seen).toContain('session.created:ses_stranger');
    expect(seen).toContain('session.step.started:ses_child');
    expect(seen).not.toContain('session.step.started:ses_stranger');
  });

  it('answers permission requests from policy and keeps going', async () => {
    const result = await iterate(
      {
        script: [
          {
            type: 'session.permission.requested',
            data: { id: 'per_1', action: 'shell', resources: ['git push origin main'] },
          },
          {
            type: 'session.permission.requested',
            data: { id: 'per_2', action: 'shell', resources: ['npm test'] },
          },
          { type: 'session.text.ended', data: { text: 'done' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('progressed');
    expect(server?.replies).toEqual([
      { requestID: 'per_1', reply: 'reject' },
      { requestID: 'per_2', reply: 'once' },
    ]);
  });

  it('ends the turn at once when a permission reply is rejected', async () => {
    const started = Date.now();
    const result = await iterate(
      {
        replyStatus: 400,
        script: [
          { type: 'session.text.ended', data: { text: '<promise>COMPLETE</promise>' } },
          { type: 'session.permission.requested', data: { id: 'per_1', action: 'shell', resources: ['npm test'] } },
          // The agent is blocked on the request and never gets this far.
          { after: 5_000, type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Permission reply for shell was rejected by the server (400): reply refused');
    expect(Date.now() - started).toBeLessThan(2_000);
    // A rejected request is not retried, and the blocked session is stopped.
    expect(server?.replyAttempts).toBe(1);
    expect(server?.interrupts).toBe(1);
  });

  it('retries a permission reply the server failed to take, then gives up', async () => {
    const result = await iterate(
      {
        replyStatus: 500,
        script: [
          { type: 'session.permission.requested', data: { id: 'per_1', action: 'shell', resources: ['npm test'] } },
          { after: 5_000, type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('failed');
    expect(server?.replyAttempts).toBe(2);
    expect(server?.interrupts).toBe(1);
  });

  it('carries on when a permission request is already gone', async () => {
    const result = await iterate(
      {
        replyStatus: 404,
        script: [
          { type: 'session.permission.requested', data: { id: 'per_1', action: 'shell', resources: ['npm test'] } },
          { type: 'session.text.ended', data: { text: 'done' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('progressed');
    expect(server?.interrupts).toBe(0);
  });

  describe('forms', () => {
    // As opencode sends it: the session is named on the form, not on the event.
    const form = (id: string, sessionID: string, kind = 'question') => ({
      type: 'form.created',
      raw: true,
      data: { form: { id, sessionID, title: 'Questions', metadata: { kind }, fields: [] } },
    });

    it('cancels a form with a message and carries on', async () => {
      const result = await iterate(
        {
          script: [
            form('frm_1', 'ses_fake_1'),
            { type: 'session.text.ended', data: { text: 'Two questions: …' } },
            { type: 'session.execution.succeeded' },
          ],
        },
        config(),
      );

      expect(result.status).toBe('progressed');
      expect(server?.formCancels).toEqual([{ sessionID: 'ses_fake_1', formID: 'frm_1', message: FORM_CANCEL_MESSAGE }]);
      expect(server?.interrupts).toBe(0);
    });

    it("cancels any kind of form, a subagent's too, but not another session's", async () => {
      const result = await iterate(
        {
          script: [
            { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_fake_1' } },
            form('frm_mcp', 'ses_fake_1', 'mcp'),
            form('frm_child', 'ses_child'),
            form('frm_stranger', 'ses_stranger'),
            { type: 'session.execution.succeeded' },
          ],
        },
        config(),
      );

      expect(result.status).toBe('progressed');
      expect(server?.formCancels.map((cancel) => cancel.formID)).toEqual(['frm_mcp', 'frm_child']);
    });

    it("sends the caller's message", async () => {
      await iterate(
        { script: [form('frm_1', 'ses_fake_1'), { type: 'session.execution.succeeded' }] },
        config(),
        { formMessage: 'Ask in your reply.' },
      );

      expect(server?.formCancels[0]?.message).toBe('Ask in your reply.');
    });

    it.each([404, 409])('carries on when the form is already settled (%i)', async (status) => {
      const result = await iterate(
        {
          formCancelStatus: status,
          script: [form('frm_1', 'ses_fake_1'), { type: 'session.execution.succeeded' }],
        },
        config(),
      );

      expect(result.status).toBe('progressed');
      expect(server?.formCancelAttempts).toBe(1);
    });

    it('retries a cancel the server failed to take, then ends the turn', async () => {
      const result = await iterate(
        {
          formCancelStatus: 500,
          script: [
            form('frm_1', 'ses_fake_1'),
            // The agent is blocked on the form and never gets this far.
            { after: 5_000, type: 'session.execution.succeeded' },
          ],
        },
        config(),
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Cancel of a question form was rejected by the server (500): cancel refused');
      expect(server?.formCancelAttempts).toBe(2);
      expect(server?.interrupts).toBe(1);
    });
  });

  it('ignores events belonging to other sessions', async () => {
    const result = await iterate(
      {
        script: [
          { type: 'session.text.ended', data: { sessionID: 'ses_other', text: 'not mine' } },
          { type: 'session.text.ended', data: { text: 'mine' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
    );

    expect(result.text).toBe('mine');
  });

  it('marks a server-side execution failure as failed', async () => {
    const result = await iterate(
      { script: [{ type: 'session.execution.failed', data: { error: 'boom' } }] },
      config(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
  });

  it('classifies a context window overflow that compaction did not save', async () => {
    const result = await iterate(
      {
        script: [
          { type: 'session.compaction.started', data: { reason: 'auto' } },
          { type: 'session.compaction.ended', data: { reason: 'auto', text: 'summary', recent: '' } },
          {
            type: 'session.step.failed',
            data: {
              error: {
                type: 'unknown',
                message: "This model's maximum context length is 32768 tokens. Please reduce the length of the messages.",
              },
            },
          },
          { type: 'session.execution.failed' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('context-overflow');
    expect(result.error).toMatch(/maximum context length is 32768 tokens/);
    expect(result.compactions).toBe(1);
  });

  it('keeps a failure that is not an overflow as failed, with its reason', async () => {
    const result = await iterate(
      {
        script: [
          { type: 'session.step.failed', data: { error: { type: 'unknown', message: 'invalid tool schema' } } },
          { type: 'session.execution.failed' },
        ],
      },
      config(),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('invalid tool schema');
  });

  it('sends the configured model and agent with the prompt', async () => {
    await iterate(
      { script: [{ type: 'session.execution.succeeded' }] },
      config({ model: 'ollama/qwen3', agent: 'build' }),
    );

    expect(server?.prompts[0]).toMatchObject({
      text: 'do the thing',
      agent: 'build',
      model: { providerID: 'ollama', modelID: 'qwen3' },
    });
  });

  it('continues an existing session instead of opening a new one', async () => {
    const seen: OpencodeEvent[] = [];
    const result = await iterate(
      {
        script: [
          { type: 'session.text.ended', data: { text: 'second turn' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
      { sessionId: 'ses_fake_1', hooks: { onEvent: (event) => seen.push(event) } },
    );

    expect(seen[0]).toMatchObject({ type: 'ralph.turn.started', data: { sessionID: 'ses_fake_1', continued: true } });
    expect(server?.sessionsCreated).toBe(0);
    expect(result.sessionId).toBe('ses_fake_1');
    expect(result.text).toBe('second turn');
  });

  it('answers permissions from a caller-supplied policy', async () => {
    await iterate(
      {
        script: [
          { type: 'session.permission.requested', data: { id: 'per_1', action: 'shell', resources: ['ls'] } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
      { permissions: () => ({ reply: 'reject', reason: 'outside-scope' }) },
    );

    expect(server?.replies).toEqual([{ requestID: 'per_1', reply: 'reject' }]);
  });

  describe('wrap-up', () => {
    const wrapUp = { prompt: (trigger: string) => `Time is up (${trigger}), hand off.` };
    const say = (text: string) => [
      { type: 'session.text.ended', data: { text } },
      { type: 'session.execution.succeeded' },
    ];
    // The working turn would run far past every budget in these tests.
    const endless = [{ after: 60_000, type: 'session.execution.succeeded' }];

    it('steers a working agent into the wrap-up when the server supports it', async () => {
      const result = await iterate(
        { steer: true, script: (count) => (count === 1 ? endless : say('handoff written')) },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.wrapUp).toMatchObject({ trigger: 'iteration-timeout', delivery: 'steer', completed: true });
      expect(result.error).toMatch(/^Iteration exceeded/);
      expect(result.text).toBe('handoff written');
      expect(server?.prompts[1]).toMatchObject({ text: 'Time is up (iteration-timeout), hand off.', delivery: 'steer' });
      expect(server?.interrupts).toBe(0);
    });

    it('interrupts first when the server cannot steer', async () => {
      const result = await iterate(
        { script: (count) => (count === 1 ? endless : say('handoff written')) },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.wrapUp).toMatchObject({ delivery: 'interrupt', completed: true });
      expect(server?.interrupts).toBe(1);
      expect(server?.prompts[1]).not.toHaveProperty('delivery');
    });

    it('ignores a BLOCKED raised in a time wrap-up: running out of time is not being blocked', async () => {
      const result = await iterate(
        {
          steer: true,
          script: (count) =>
            count === 1 ? endless : say('handoff written <promise>BLOCKED:not applicable — handoff written</promise>'),
        },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.tags.blockedReason).toBeUndefined();
    });

    it('ignores a DECIDE raised in a time wrap-up', async () => {
      const result = await iterate(
        { steer: true, script: (count) => (count === 1 ? endless : say('<promise>DECIDE:A or B?</promise>')) },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.tags.decideQuestion).toBeUndefined();
    });

    it('keeps a BLOCKED raised after an inactivity wrap-up, since a hung command may be the environment', async () => {
      const result = await iterate(
        { script: (count) => (count === 1 ? endless : say('<promise>BLOCKED:the database is down</promise>')) },
        config({ timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('blocked');
      expect(result.tags.blockedReason).toBe('the database is down');
    });

    it('ignores a BLOCKED raised in a time wrap-up that interrupted the agent first', async () => {
      const result = await iterate(
        { script: (count) => (count === 1 ? endless : say('<promise>BLOCKED:out of time</promise>')) },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.wrapUp).toMatchObject({ trigger: 'iteration-timeout', delivery: 'interrupt' });
      expect(result.status).toBe('wrapped-up');
      expect(result.tags.blockedReason).toBeUndefined();
    });

    it('ignores a BLOCKED or DECIDE raised in a park wrap-up', async () => {
      const park = new AbortController();
      setTimeout(() => park.abort(), 50);
      const result = await iterate(
        {
          steer: true,
          script: (count) =>
            count === 1 ? endless : say('<promise>BLOCKED:parked</promise> <promise>DECIDE:A or B?</promise>'),
        },
        config({ timeouts: { iterationMs: 60_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp, park: park.signal },
      );

      expect(result.wrapUp).toMatchObject({ trigger: 'park' });
      expect(result.status).toBe('wrapped-up');
      expect(result.tags.blockedReason).toBeUndefined();
      expect(result.tags.decideQuestion).toBeUndefined();
    });

    it('ignores a DECIDE raised after an inactivity wrap-up', async () => {
      const result = await iterate(
        { script: (count) => (count === 1 ? endless : say('<promise>DECIDE:A or B?</promise>')) },
        config({ timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.tags.decideQuestion).toBeUndefined();
    });

    it('keeps a BLOCKED raised before the wrap-up was sent', async () => {
      const result = await iterate(
        {
          steer: true,
          script: (count) =>
            count === 1
              ? [{ type: 'session.text.ended', data: { text: '<promise>BLOCKED:no API key</promise>' } }, ...endless]
              : say('handoff written'),
        },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.wrapUp).toMatchObject({ trigger: 'iteration-timeout' });
      expect(result.status).toBe('blocked');
      expect(result.tags.blockedReason).toBe('no API key');
    });

    it('keeps the task claims and the rest of the tags in a wrap-up', async () => {
      const result = await iterate(
        {
          steer: true,
          script: (count) =>
            count === 1 ? endless : say('<promise>TASK-1:DONE</promise> <promise>BLOCKED:out of time</promise>'),
        },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.tags.completedTaskIds).toEqual(['TASK-1']);
      expect(result.tags.blockedReason).toBeUndefined();
    });

    it('interrupts a quiet agent, which is stuck in a tool, even when steering is available', async () => {
      const result = await iterate(
        { steer: true, script: (count) => (count === 1 ? endless : say('handoff written')) },
        config({ timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 5_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('wrapped-up');
      expect(result.wrapUp).toMatchObject({ trigger: 'inactivity', delivery: 'interrupt' });
      expect(result.error).toMatch(/No activity/);
      expect(server?.prompts[1]?.['text']).toContain('inactivity');
    });

    it('gives up at the wrap-up budget and reports a timeout', async () => {
      const result = await iterate(
        { steer: true, script: (count) => (count === 1 ? endless : []) },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 2_000 } }),
        { wrapUp },
      );

      expect(result.status).toBe('timeout');
      expect(result.wrapUp).toMatchObject({ completed: false });
      expect(result.error).toMatch(/Wrap-up exceeded/);
      expect(server?.interrupts).toBe(1);
    });

    it('interrupts outright when the wrap-up budget is 0', async () => {
      const result = await iterate(
        { steer: true, script: endless },
        config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 0 } }),
        { wrapUp },
      );

      expect(result.status).toBe('timeout');
      expect(result.wrapUp).toBeUndefined();
      expect(server?.prompts).toHaveLength(1);
    });
  });
});

describe('joinTurns', () => {
  const turn = (overrides: Partial<IterationResult>): IterationResult => ({
    sessionId: 'ses_1',
    status: 'progressed',
    text: '',
    tags: { complete: false, completedTaskIds: [] },
    usage: { input: 10, output: 1, reasoning: 0, cacheRead: 100, cacheWrite: 0, cost: 0.5 },
    toolCalls: 2,
    filesTouched: ['a.ts'],
    providerRetries: 0,
    compactions: 0,
    durationMs: 1_000,
    ...overrides,
  });

  it('adds up what the turns did and ends as the second one did', () => {
    const joined = joinTurns(
      turn({ text: 'waiting on the tests' }),
      turn({ text: '<promise>TASK-1:DONE</promise>', tags: { complete: false, completedTaskIds: ['TASK-1'] }, filesTouched: ['a.ts', 'b.ts'], compactions: 1 }),
    );

    expect(joined.text).toBe('waiting on the tests\n<promise>TASK-1:DONE</promise>');
    expect(joined.tags.completedTaskIds).toEqual(['TASK-1']);
    expect(joined.usage).toMatchObject({ input: 20, output: 2, cacheRead: 200, cost: 1 });
    expect(joined.toolCalls).toBe(4);
    expect(joined.filesTouched).toEqual(['a.ts', 'b.ts']);
    expect(joined.compactions).toBe(1);
    expect(joined.durationMs).toBe(2_000);
  });
});

describe('runIteration asks', () => {
  const formEvent = (id: string, sessionID = 'ses_fake_1') => ({
    type: 'form.created',
    raw: true,
    data: {
      form: { id, sessionID, title: 'Questions', metadata: { kind: 'question' }, fields: [{ key: 'a', type: 'string', title: 'Which?' }] },
    },
  });
  // The agent carries on once its form is settled.
  const carryOn = () => {
    server!.emit({ type: 'session.text.ended', data: { text: 'Thanks, carrying on.' } });
    server!.emit({ type: 'session.execution.succeeded' });
  };

  /** A person scripted in memory: answers each ask in turn, after `delayMs`. */
  function person(answers: Array<FormOutcome | 'once' | 'always' | 'reject' | null>, delayMs = 20) {
    const calls: string[] = [];
    const rejected: Array<{ id: string; error: string }> = [];
    const settled: string[] = [];
    const next = async (id: string, signal: AbortSignal) => {
      calls.push(id);
      const answer = answers.shift();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, answer === null ? 60_000 : delayMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
      return signal.aborted || answer === null ? undefined : answer;
    };
    const relay: AskRelay = {
      form: async (form, signal) => (await next(form.id, signal)) as FormOutcome | undefined,
      permission: async (request, signal) => (await next(request.id, signal)) as 'once' | 'always' | 'reject' | undefined,
      rejected: (id, error) => rejected.push({ id, error }),
      settled: (id) => settled.push(id),
    };
    return { relay, calls, rejected, settled };
  }

  it("delivers a person's answer to a form, and the turn carries on", async () => {
    const { relay, settled } = person([{ answer: { a: 'Node' } }]);
    const result = await iterate(
      { script: [formEvent('frm_1')], onFormSettled: carryOn },
      config(),
      { asks: relay },
    );

    expect(result.status).toBe('progressed');
    expect(result.asks).toBe(1);
    expect(server?.formReplies).toEqual([{ sessionID: 'ses_fake_1', formID: 'frm_1', answer: { a: 'Node' } }]);
    expect(server?.formCancels).toEqual([]);
    expect(settled).toEqual(['frm_1']);
  });

  it('asks again when the server turns the answer down', async () => {
    const { relay, rejected, calls } = person([{ answer: {} }, { answer: { a: 'Node' } }]);
    const result = await iterate(
      { formReplyStatuses: [400], script: [formEvent('frm_1')], onFormSettled: carryOn },
      config(),
      { asks: relay },
    );

    expect(result.status).toBe('progressed');
    expect(rejected).toEqual([{ id: 'frm_1', error: 'The answer was rejected by the server (400): Invalid answer: a is required' }]);
    expect(calls).toEqual(['frm_1', 'frm_1']);
    expect(server?.formReplies.map((reply) => reply.answer)).toEqual([{ a: 'Node' }]);
  });

  it('cancels with what the person said when they decline', async () => {
    const { relay } = person([{ cancel: 'Not now.' }]);
    await iterate({ script: [formEvent('frm_1')], onFormSettled: carryOn }, config(), { asks: relay });

    expect(server?.formCancels).toEqual([{ sessionID: 'ses_fake_1', formID: 'frm_1', message: 'Not now.' }]);
  });

  it('does not let the watchdog trip while a person is asked', async () => {
    const { relay } = person([{ answer: { a: 'Node' } }], 1_500);
    const result = await iterate(
      { script: [formEvent('frm_1')], onFormSettled: carryOn },
      config({ timeouts: { inactivityMs: 1_000, iterationMs: 1_200, wrapUpMs: 0 } }),
      { asks: relay },
    );

    expect(result.status).toBe('progressed');
    expect(result.trip).toBeUndefined();
  });

  it('cancels a form nobody answers within timeouts.askMs', async () => {
    const { relay } = person([null]);
    const result = await iterate(
      { script: [formEvent('frm_1')], onFormSettled: carryOn },
      config({ timeouts: { askMs: 100 } }),
      { asks: relay },
    );

    expect(result.status).toBe('progressed');
    expect(server?.formCancels).toEqual([{ sessionID: 'ses_fake_1', formID: 'frm_1', message: FORM_EXPIRED_MESSAGE }]);
  });

  it('stops asking about a form settled elsewhere', async () => {
    const { relay, settled } = person([null]);
    const result = await iterate(
      {
        script: [
          formEvent('frm_1'),
          { after: 50, type: 'form.replied', raw: true, data: { id: 'frm_1', sessionID: 'ses_fake_1', answer: { a: 'x' } } },
          { after: 60, type: 'session.execution.succeeded' },
        ],
      },
      config(),
      { asks: relay },
    );

    expect(result.status).toBe('progressed');
    expect(settled).toEqual(['frm_1']);
    expect(server?.formReplies).toEqual([]);
    expect(server?.formCancels).toEqual([]);
  });

  it('puts a permission the policy leaves to a person to them', async () => {
    const { relay } = person(['always']);
    const result = await iterate(
      {
        script: [
          { type: 'session.permission.requested', data: { id: 'per_1', action: 'shell', resources: ['make deploy'] } },
          { after: 100, type: 'session.execution.succeeded' },
        ],
      },
      config({ permissions: { fallback: 'ask' } }),
      { asks: relay },
    );

    expect(result.status).toBe('progressed');
    expect(server?.replies).toEqual([{ requestID: 'per_1', reply: 'always' }]);
  });

  it('rejects such a permission with nobody to ask, and still applies allow rules', async () => {
    await iterate(
      {
        script: [
          { type: 'session.permission.requested', data: { id: 'per_1', action: 'shell', resources: ['make deploy'] } },
          { type: 'session.permission.requested', data: { id: 'per_2', action: 'read', resources: ['a.ts'] } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config({ permissions: { fallback: 'ask', allow: ['read'] } }),
    );

    expect(server?.replies).toEqual([
      { requestID: 'per_1', reply: 'reject' },
      { requestID: 'per_2', reply: 'always' },
    ]);
  });

  it('leaves asks in the Ralph folder for the web UI, and clears them once answered', async () => {
    const ralphRoot = mkdtempSync(join(tmpdir(), 'ralph-iter-asks-'));
    const relay = fileAskRelay({ ralphRoot, origin: { run: 'run-1' }, taskId: () => 'TASK-3', pollMs: 10 });
    const answering = (async () => {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const ask = listAsks(ralphRoot)[0];
        if (!ask) continue;
        expect(ask).toMatchObject({ kind: 'form', origin: 'run', runId: 'run-1', taskId: 'TASK-3', sessionID: 'ses_fake_1' });
        expect(readAsk(ralphRoot, ask.id)?.form?.fields).toEqual([{ key: 'a', type: 'string', title: 'Which?' }]);
        writeAskAnswer(ralphRoot, { id: ask.id, answer: { a: 'Node' }, by: 'ui', answeredAt: new Date().toISOString() });
        return;
      }
    })();
    const result = await iterate({ script: [formEvent('frm_1')], onFormSettled: carryOn }, config(), { asks: relay });
    await answering;

    expect(result.status).toBe('progressed');
    expect(server?.formReplies[0]?.answer).toEqual({ a: 'Node' });
    expect(listAsks(ralphRoot)).toEqual([]);
  });
});
