import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { HarnessApiError } from '../src/harness/types.js';
import { runIteration } from '../src/loop/iteration.js';
import { restrictWrites } from '../src/loop/permissions.js';
import { preflight } from '../src/loop/preflight.js';
import { Logger } from '../src/report/logger.js';
import { FakeHarness, SESSION, event, type FakeHarnessOptions } from './helpers/fake-harness.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WritableStream });

function config(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ projectRoot: process.cwd(), ...overrides });
}

const say = (text: string) => [
  event('session.text.ended', SESSION, { text }),
  event('session.execution.succeeded', SESSION),
];

function iterate(harness: FakeHarness, cfg: Config = config(), extra: Partial<Parameters<typeof runIteration>[0]> = {}) {
  return runIteration({ harness, config: cfg, prompt: 'go', title: 'test', logger, signal: new AbortController().signal, ...extra });
}

describe('the harness contract the loop relies on', () => {
  it('subscribes before it prompts, so what the prompt triggers is not missed', async () => {
    const harness = new FakeHarness({ script: () => say('hello'), connectMs: 30 });

    const result = await iterate(harness);

    expect(harness.calls.indexOf('connected')).toBeGreaterThanOrEqual(0);
    expect(harness.calls.indexOf('connected')).toBeLessThan(harness.calls.indexOf('prompt'));
    expect(harness.calls.indexOf('connected')).toBeLessThan(harness.calls.indexOf('createSession'));
    expect(result.text).toBe('hello');
  });

  describe('the wrap-up', () => {
    const wrapUp = { prompt: (trigger: string) => `Time is up (${trigger}), hand off.` };
    const endless = (count: number, rest: FakeHarnessOptions['script']) => (count === 1 ? [] : rest(count));
    const timeouts = (overrides: Record<string, number>) =>
      config({ timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000, ...overrides } });

    it('steers when the harness declares steering', async () => {
      const harness = new FakeHarness({
        capabilities: { steering: true },
        script: (count) => endless(count, () => say('handoff written')),
      });

      const result = await iterate(harness, timeouts({}), { wrapUp });

      expect(result.wrapUp).toMatchObject({ trigger: 'iteration-timeout', delivery: 'steer', completed: true });
      expect(harness.prompts[1]?.options).toEqual({ delivery: 'steer' });
      expect(harness.interrupted).toEqual([]);
    });

    it('interrupts first when the harness does not declare steering', async () => {
      const harness = new FakeHarness({ script: (count) => endless(count, () => say('handoff written')) });

      const result = await iterate(harness, timeouts({}), { wrapUp });

      expect(result.wrapUp).toMatchObject({ delivery: 'interrupt', completed: true });
      expect(harness.interrupted).toEqual([SESSION]);
      expect(harness.calls.indexOf('interrupt')).toBeLessThan(harness.calls.lastIndexOf('prompt'));
      expect(harness.prompts[1]?.options).not.toHaveProperty('delivery');
    });

    it('interrupts a quiet agent even when the harness can steer', async () => {
      const harness = new FakeHarness({
        capabilities: { steering: true },
        script: (count) => endless(count, () => say('handoff written')),
      });

      const result = await iterate(harness, timeouts({ iterationMs: 60_000, inactivityMs: 1_000 }), { wrapUp });

      expect(result.wrapUp).toMatchObject({ trigger: 'inactivity', delivery: 'interrupt' });
      expect(harness.interrupted).toEqual([SESSION]);
    });
  });

  describe('subagents', () => {
    const permission = (sessionID: string) =>
      event('permission.asked', sessionID, { id: 'req_1', action: 'shell', resources: [] });
    const allow = () => ({ reply: 'once' as const, reason: 'allow-rule' as const });
    const child = (parentID?: string) => event('session.created', 'ses_child', parentID ? { parentID } : {});
    const script = () => [child('ses_fake'), permission('ses_child'), ...say('done')];

    it('answers a child session\'s requests when the harness declares subagents', async () => {
      const harness = new FakeHarness({ capabilities: { subagents: true }, script });

      await iterate(harness, config(), { permissions: allow });

      expect(harness.permissionReplies).toEqual([{ sessionId: 'ses_child', requestId: 'req_1', reply: 'once' }]);
      expect(harness.parentLookups).toEqual([]);
    });

    it('asks the harness for the parent when the event does not name it', async () => {
      const harness = new FakeHarness({
        capabilities: { subagents: true },
        script: () => [child(), permission('ses_child'), ...say('done')],
      });

      await iterate(harness, config(), { permissions: allow });

      expect(harness.parentLookups).toEqual(['ses_child']);
      expect(harness.permissionReplies).toHaveLength(1);
    });

    it('attributes nothing and looks nothing up when it does not', async () => {
      const harness = new FakeHarness({ script });

      const result = await iterate(harness, config(), { permissions: allow });

      expect(result.text).toBe('done');
      expect(harness.permissionReplies).toEqual([]);
      expect(harness.parentLookups).toEqual([]);
    });
  });

  it('treats a permission reply the harness reports gone (404) as answered', async () => {
    const harness = new FakeHarness({
      script: () => [event('permission.asked', SESSION, { id: 'req_1', action: 'shell', resources: [] }), ...say('done')],
      replyPermissionError: new HarnessApiError('gone', 404, ''),
    });

    const result = await iterate(harness, config(), { permissions: () => ({ reply: 'once', reason: 'allow-rule' }) });

    expect(result.status).toBe('progressed');
    expect(result.error).toBeUndefined();
  });

  describe('the reason a request is turned down', () => {
    const asks = () => [event('permission.asked', SESSION, { id: 'req_1', action: 'shell', resources: ['git push origin main'] }), ...say('done')];
    const rule = (overrides: Record<string, unknown>) => config({ permissions: overrides });

    it('names the deny rule that matched', async () => {
      const harness = new FakeHarness({ script: asks });

      await iterate(harness, rule({}));

      expect(harness.permissionReplies).toEqual([
        { sessionId: SESSION, requestId: 'req_1', reply: 'reject', reason: 'it matches the deny rule "git push"' },
      ]);
    });

    it('names the write scope that was left', async () => {
      const harness = new FakeHarness({
        script: () => [event('permission.asked', SESSION, { id: 'req_1', action: 'edit', resources: ['src/a.ts'] }), ...say('done')],
      });

      await iterate(harness, config(), { permissions: restrictWrites(config().permissions, process.cwd(), '.ralph') });

      expect(harness.permissionReplies[0]).toMatchObject({ reply: 'reject', reason: expect.stringContaining('"src/a.ts" is outside') });
    });

    it('says there is nobody to ask when the policy leaves it to a person and none can answer', async () => {
      const harness = new FakeHarness({ script: () => [event('permission.asked', SESSION, { id: 'req_1', action: 'shell', resources: ['make'] }), ...say('done')] });

      await iterate(harness, rule({ fallback: 'ask' }));

      expect(harness.permissionReplies[0]).toMatchObject({ reply: 'reject', reason: 'there is nobody to ask' });
    });

    it('gives none with a yes', async () => {
      const harness = new FakeHarness({ script: () => [event('permission.asked', SESSION, { id: 'req_1', action: 'shell', resources: ['ls'] }), ...say('done')] });

      await iterate(harness, config());

      expect(harness.permissionReplies).toEqual([{ sessionId: SESSION, requestId: 'req_1', reply: 'once' }]);
    });
  });
});

describe('preflight', () => {
  it('runs the project checks, then the harness\'s own', async () => {
    const harness = new FakeHarness({ script: () => [] });
    const root = mkdtempSync(join(tmpdir(), 'ralph-harness-'));

    const results = await preflight(config({ projectRoot: root }), harness);

    expect(results.map((check) => check.name)).toEqual(['prompt', 'prd', 'tasks', 'fake']);
    expect(harness.preflightCalls).toBe(1);
  });
});
