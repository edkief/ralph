import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer } from './helpers/fake-server.js';
import { OpencodeClient } from '../src/opencode/client.js';
import { runIteration } from '../src/loop/iteration.js';
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
  extra: Pick<Parameters<typeof runIteration>[0], 'sessionId' | 'permissions' | 'wrapUp'> = {},
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
    const result = await iterate(
      {
        script: [
          { type: 'session.text.ended', data: { text: 'second turn' } },
          { type: 'session.execution.succeeded' },
        ],
      },
      config(),
      { sessionId: 'ses_fake_1' },
    );

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
