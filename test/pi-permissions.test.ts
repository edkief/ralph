import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import type { EventOf, HarnessEvent } from '../src/harness/events.js';
import { HarnessApiError } from '../src/harness/types.js';
import { listAsks, readAsk, writeAskAnswer } from '../src/human/asks.js';
import { runInterview, type InterviewIO } from '../src/init/interview.js';
import { scaffold } from '../src/init/scaffold.js';
import { fileAskRelay } from '../src/loop/asks.js';
import { runIteration } from '../src/loop/iteration.js';
import { restrictWrites } from '../src/loop/permissions.js';
import { GATE_EXTENSION } from '../src/pi/gate.js';
import { Logger, type LogEntry } from '../src/report/logger.js';
import type { FakePiOptions } from './helpers/pi.js';
import { piRig, quietLogger, type PiRig } from './helpers/pi-harness.js';

/**
 * Ralph's policy over pi's tool calls: the gate extension puts each one to Ralph, the loop judges it as it
 * does a permission an opencode agent asks for, and the call is blocked or runs. Over a fake pi that replays
 * sessions recorded with the real extension (test/fixtures/pi/gate-*.jsonl).
 */
const rigs: PiRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((made) => made.close()));
});

const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !condition()) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  return condition();
};

/** A logger that keeps what it is given, at every level. */
function recordingLogger() {
  const entries: LogEntry[] = [];
  const logger = new Logger({ level: 'debug', stream: { write: () => true } as NodeJS.WritableStream });
  logger.addSink((entry) => entries.push(entry));
  return { logger, entries, decided: () => entries.filter((entry) => entry.message === 'permission decided') };
}

const ONLY_ACTION = (event: HarnessEvent): event is EventOf<'permission.asked'> => event.type === 'permission.asked';
const finished = (events: HarnessEvent[]) => events.find((event): event is EventOf<'tool.finished'> => event.type === 'tool.finished');

async function turn(fake: FakePiOptions, overrides: Record<string, unknown> = {}, extra: Partial<Parameters<typeof runIteration>[0]> = {}) {
  const made = await piRig(fake, overrides);
  rigs.push(made);
  const config: Config = ConfigSchema.parse({ ...made.config, ...overrides, harness: 'pi', pi: made.config.pi });
  const events: HarnessEvent[] = [];
  const log = recordingLogger();
  const result = await runIteration({
    harness: made.harness,
    config,
    prompt: 'do the thing',
    title: 'test',
    logger: log.logger,
    signal: new AbortController().signal,
    hooks: { onEvent: (event) => events.push(event) },
    ...extra,
  });
  return { result, made, events, log, config };
}

const gate = (command: string): FakePiOptions => ({ captures: ['gate-allow'], swap: { 'echo hello': command } });

describe('the default deny list under pi', () => {
  it('blocks git push, tells the agent which rule, and logs the rule', async () => {
    const { result, events, log } = await turn(gate('git push origin main'));

    expect(result.status).toBe('complete');
    const call = events.find(ONLY_ACTION);
    expect(call).toMatchObject({ gate: true, action: 'bash', resources: ['git push origin main'] });
    // What the agent reads in place of the command's output.
    expect(finished(events)).toMatchObject({ status: 'error', output: expect.stringContaining('it matches the deny rule "git push"') });
    expect(finished(events)?.output).toContain("Ralph's permissions do not allow this");
    // The audit log: the decision and the rule that made it.
    expect(log.decided()).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({ action: 'bash', resources: ['git push origin main'], reply: 'reject', reason: 'deny-rule', matched: 'git push' }),
      }),
    ]);
  });

  it('blocks the other default rules the same way', async () => {
    for (const command of ['git remote add evil x', 'rm -rf / --no-preserve-root', 'sudo shutdown now']) {
      const { events } = await turn(gate(command));
      expect(finished(events), command).toMatchObject({ status: 'error' });
    }
  });

  it('matches a command that hides the pattern deep inside it', async () => {
    const { events, log } = await turn(gate(`${'echo ok; '.repeat(3_000)}git push`));
    expect(finished(events)).toMatchObject({ status: 'error' });
    expect(log.decided()[0]?.fields).toMatchObject({ matched: 'git push' });
  });

  it('lets a command no rule names run, and logs it only for someone who asks for debug', async () => {
    const { events, log } = await turn(gate('npm test'));

    expect(finished(events)).toMatchObject({ status: 'success' });
    expect(log.decided()).toEqual([expect.objectContaining({ level: 'debug', fields: expect.objectContaining({ reply: 'once' }) })]);
  });
});

describe('calls a codemode script makes, under pi 1.x', () => {
  // The script assembles `git push origin main`, so only the call it makes shows the command.
  const codemode: FakePiOptions = { captures: ['codemode-nested-allow'], gateSessions: ['codemode-nested-allow', 'codemode-nested-block'] };

  it('judges the script, then each call it makes, and blocks a denied one', async () => {
    const { result, events, log } = await turn(codemode);

    expect(result.status).toBe('complete');
    const asked = events.filter(ONLY_ACTION);
    expect(asked.map((event) => event.action)).toEqual(['codemode', 'bash']);
    expect(asked[1]).toMatchObject({ gate: true, resources: ['git push origin main'] });
    const nested = events.find((event): event is EventOf<'tool.finished'> => event.type === 'tool.finished' && event.parent === 'call_1');
    expect(nested).toMatchObject({ id: 'call_1/1', name: 'bash', status: 'error', output: expect.stringContaining('it matches the deny rule "git push"') });
    expect(log.decided().map((entry) => entry.fields?.['reply'])).toEqual(['once', 'reject']);
  });
});

describe('MCP tools, under pi 1.x', () => {
  it('puts an MCP tool call to the rules like any other', async () => {
    const mcp: FakePiOptions = { captures: ['mcp-tool'], gateSessions: ['mcp-tool', 'gate-block'] };
    const allowed = await turn(mcp);
    expect(allowed.events.find(ONLY_ACTION)).toMatchObject({ gate: true, action: 'mcp__echo__say', resources: ['{"text":"hello"}'] });
    expect(finished(allowed.events)).toMatchObject({ status: 'success', name: 'mcp__echo__say', output: 'said: hello' });

    const refused = await turn(mcp, { permissions: { deny: ['mcp__echo__say'] } });
    expect(refused.log.decided()[0]?.fields).toMatchObject({ reply: 'reject', matched: 'mcp__echo__say' });
    expect(finished(refused.events)).toMatchObject({ status: 'error' });
  });
});

describe('allow rules and the fallback', () => {
  it('rejects what no allow rule names when the fallback is reject, and says so', async () => {
    const overrides = { permissions: { fallback: 'reject', allow: ['npm test'] } };

    const allowed = await turn(gate('npm test'), overrides);
    expect(finished(allowed.events)).toMatchObject({ status: 'success' });

    const refused = await turn(gate('ls -la'), overrides);
    expect(finished(refused.events)).toMatchObject({ status: 'error', output: expect.stringContaining('no rule allows it') });
    expect(refused.log.decided()[0]?.fields).toMatchObject({ reply: 'reject', reason: 'fallback' });
  });

  it('lets a deny rule beat an allow rule', async () => {
    const { events } = await turn(gate('git push'), { permissions: { allow: ['git push'] } });
    expect(finished(events)).toMatchObject({ status: 'error' });
  });
});

describe('the write scope of a planning turn', () => {
  const write = (path: string): FakePiOptions => ({ captures: ['gate-write'], swap: { 'src/app.ts': path } });
  const scoped = (made: PiRig) => restrictWrites(made.config.permissions, made.config.projectRoot, '.ralph');

  it('blocks a write outside .ralph/ before it happens', async () => {
    const made = await piRig(write('src/app.ts'));
    rigs.push(made);
    const events: HarnessEvent[] = [];
    const result = await runIteration({
      harness: made.harness,
      config: made.config,
      prompt: 'plan',
      title: 'plan',
      permissions: scoped(made),
      logger: quietLogger,
      signal: new AbortController().signal,
      hooks: { onEvent: (event) => events.push(event) },
    });

    expect(result.status).toBe('complete');
    expect(events.find(ONLY_ACTION)).toMatchObject({ action: 'write', resources: ['src/app.ts'] });
    expect(finished(events)).toMatchObject({ status: 'error', output: expect.stringContaining('"src/app.ts" is outside the folder this session may write in') });
  });

  it('lets a write inside .ralph/ run, by a relative or an absolute path', async () => {
    for (const absolute of [false, true]) {
      const root = mkdtempSync(resolve(tmpdir(), 'ralph-pi-scope-'));
      const path = absolute ? resolve(root, '.ralph/prd/PRD.md') : '.ralph/prd/PRD.md';
      const made = await piRig({ captures: ['gate-write'], swap: { 'src/app.ts': path } }, { projectRoot: root }, { cwd: root });
      rigs.push(made);
      const events: HarnessEvent[] = [];
      await runIteration({
        harness: made.harness,
        config: made.config,
        prompt: 'plan',
        title: 'plan',
        permissions: scoped(made),
        logger: quietLogger,
        signal: new AbortController().signal,
        hooks: { onEvent: (event) => events.push(event) },
      });
      expect(events.find(ONLY_ACTION)?.resources, path).toEqual([path]);
      expect(finished(events), path).toMatchObject({ status: 'success' });
    }
  });

  it('keeps the deny rules in force inside the scope', async () => {
    const made = await piRig({ captures: ['gate-allow'], swap: { 'echo hello': 'git push' } });
    rigs.push(made);
    const events: HarnessEvent[] = [];
    await runIteration({
      harness: made.harness,
      config: made.config,
      prompt: 'plan',
      title: 'plan',
      permissions: scoped(made),
      logger: quietLogger,
      signal: new AbortController().signal,
      hooks: { onEvent: (event) => events.push(event) },
    });
    expect(finished(events)).toMatchObject({ status: 'error' });
  });
});

describe('ralph init over pi', () => {
  const DONE = 'Plan written. <promise>PLAN:DONE</promise>';

  /** A scaffolded git project, where the planner may write inside .ralph/ only. */
  function project(): string {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-pi-init-'));
    scaffold(root);
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: root });
    sh('init', '-q');
    sh('config', 'user.email', 'test@example.com');
    sh('config', 'user.name', 'Test');
    sh('add', '-A');
    sh('commit', '-qm', 'scaffold');
    return root;
  }

  const user = (): InterviewIO => ({ say: () => undefined, status: () => undefined, note: () => undefined, ask: async () => 'A todo app' });

  async function plan(path: string) {
    const root = project();
    const made = await piRig({ captures: ['gate-write'], swap: { 'src/app.ts': path }, say: DONE }, { projectRoot: root, plan: { maxFixAttempts: 0 } }, { cwd: root });
    rigs.push(made);
    const events: HarnessEvent[] = [];
    const outcome = await runInterview({
      harness: made.harness,
      config: made.config,
      logger: quietLogger,
      io: user(),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    return { outcome, events, made, root };
  }

  it('blocks a write outside .ralph/', async () => {
    const { events, made, root } = await plan('src/app.ts');

    expect(made.config.projectRoot).toBe(root);
    expect(events.find(ONLY_ACTION)).toMatchObject({ gate: true, action: 'write', resources: ['src/app.ts'] });
    expect(finished(events)).toMatchObject({ status: 'error', output: expect.stringContaining('outside the folder') });
    // The planner got no further than saying it was done: nothing was written, so the plan does not pass.
    expect(existsSync(resolve(root, 'src/app.ts'))).toBe(false);
  });

  it('lets a write inside .ralph/ run', async () => {
    const { events } = await plan('.ralph/prd/PRD.md');
    expect(finished(events)).toMatchObject({ status: 'success' });
  });
});

describe('an ask under pi', () => {
  const ASKING = { permissions: { fallback: 'ask' } };

  /** Run a turn with the asks relay on, answering the one ask that appears with `decide`. */
  async function asked(command: string, decide: ((ralphRoot: string, id: string) => void) | undefined, overrides: Record<string, unknown> = {}) {
    const made = await piRig(gate(command), { ...ASKING, ...overrides });
    rigs.push(made);
    const ralphRoot = resolve(made.projectRoot, '.ralph');
    const config: Config = ConfigSchema.parse({ ...made.config, ...ASKING, ...overrides, harness: 'pi', pi: made.config.pi });
    const events: HarnessEvent[] = [];
    const log = recordingLogger();
    const finishedTurn = runIteration({
      harness: made.harness,
      config,
      prompt: 'do the thing',
      title: 'test',
      asks: fileAskRelay({ ralphRoot, origin: { run: 'run-1' }, taskId: () => 'TASK-1', askMs: config.timeouts.askMs, pollMs: 10 }),
      logger: log.logger,
      signal: new AbortController().signal,
      hooks: { onEvent: (event) => events.push(event) },
    });
    const seen: Array<NonNullable<ReturnType<typeof readAsk>>> = [];
    if (await until(() => listAsks(ralphRoot).length > 0)) {
      const ask = listAsks(ralphRoot)[0]!;
      seen.push(ask);
      decide?.(ralphRoot, ask.id);
    }
    const result = await finishedTurn;
    return { result, events, log, made, seen, ralphRoot, config };
  }

  const answer = (decision: 'once' | 'always' | 'reject') => (ralphRoot: string, id: string) =>
    writeAskAnswer(ralphRoot, { id, decision, by: 'ui', answeredAt: new Date().toISOString() });

  it('is a card like opencode\'s: a permission with its action and resources, for the run and its task', async () => {
    const { seen, made, config } = await asked('make deploy', answer('once'));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'permission',
      origin: 'run',
      runId: 'run-1',
      taskId: 'TASK-1',
      sessionID: expect.any(String),
      permission: { action: 'bash', resources: ['make deploy'] },
    });
    expect(config.timeouts.askMs).toBe(0);
    expect(made.fake.gateTimeouts()).toEqual([undefined]);
    // Settled: the card is gone once the turn has gone on.
    expect(listAsks(resolve(made.projectRoot, '.ralph'))).toEqual([]);
  });

  it('runs the call on once and on always, which under pi is the same', async () => {
    for (const decision of ['once', 'always'] as const) {
      const { events } = await asked('make deploy', answer(decision));
      expect(finished(events), decision).toMatchObject({ status: 'success' });
    }
  });

  it('blocks it on reject, telling the agent the owner turned it down', async () => {
    const { events, log } = await asked('make deploy', answer('reject'));

    expect(finished(events)).toMatchObject({ status: 'error', output: expect.stringContaining('the owner turned it down') });
    expect(log.decided().at(-1)?.fields).toMatchObject({ reply: 'reject', reason: 'person' });
  });

  it('holds the turn\'s clocks while it waits', async () => {
    const { result } = await asked('make deploy', (root, id) => setTimeout(() => answer('once')(root, id), 1_300), {
      timeouts: { inactivityMs: 1_000, iterationMs: 60_000 },
    });
    expect(result.status).toBe('complete');
    expect(result.asks).toBe(1);
  });

  it('gives up after timeouts.askMs, blocks the call, and gives the gate a little longer than that', async () => {
    const { events, log, seen, made } = await asked('make deploy', undefined, { timeouts: { askMs: 400 } });

    expect(seen[0]?.expiresAt).toBeTruthy();
    expect(finished(events)).toMatchObject({ status: 'error', output: expect.stringContaining('nobody answered in time') });
    expect(log.decided().at(-1)?.fields).toMatchObject({ reply: 'reject', reason: 'not-answered' });
    expect(made.fake.gateTimeouts()).toEqual(['30400']);
  });

  it('does not ask the calls a rule settles', async () => {
    const { seen, events } = await asked('git push origin main', answer('once'));
    expect(seen).toEqual([]);
    expect(finished(events)).toMatchObject({ status: 'error' });
  });

  it('blocks the call when nobody can be asked', async () => {
    const { events, log } = await turn(gate('make deploy'), ASKING);

    expect(finished(events)).toMatchObject({ status: 'error', output: expect.stringContaining('there is nobody to ask') });
    expect(log.decided()[0]?.fields).toMatchObject({ reply: 'reject', reason: 'nobody-to-ask' });
  });
});

describe('failing closed', () => {
  it('will not open a session on a pi that did not load the extension', async () => {
    const made = await piRig({ gate: 'missing' });
    rigs.push(made);

    const failure = await made.harness.createSession('t').catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(HarnessApiError);
    expect((failure as HarnessApiError).status).toBe(502);
    expect((failure as Error).message).toContain(GATE_EXTENSION);
    expect((failure as Error).message).toContain('will not run pi');
    // The process it started is not left running.
    const [started] = made.fake.processes();
    await until(() => {
      try {
        process.kill(started!.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(started!.pid, 0)).toThrow();
    expect(made.events.some((event) => event.type === 'session.started')).toBe(false);
  });

  it('will not run a turn on such a pi', async () => {
    const made = await piRig({ gate: 'missing' });
    rigs.push(made);
    await expect(
      runIteration({ harness: made.harness, config: made.config, prompt: 'x', title: 't', logger: quietLogger, signal: new AbortController().signal }),
    ).rejects.toThrow(/permission extension/);
    expect(made.fake.commands().map((command) => command['type'])).not.toContain('prompt');
  });

  it('will not continue a session in a new process that lacks the extension either', async () => {
    const made = await piRig({ captures: ['tool-turn'], gate: 'missing-after-first' }, {}, { idleMs: 50 });
    rigs.push(made);
    const id = await made.harness.createSession('t');
    await made.harness.prompt(id, 'go');
    await made.waitFor((event) => event.type === 'execution.ended');
    // The quiet session's process is stopped; the one a later prompt starts has no extension.
    await until(() => {
      try {
        process.kill(made.fake.processes()[0]!.pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    await expect(made.harness.prompt(id, 'again')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('will not run pi') });
    expect(made.fake.processes()).toHaveLength(2);
    expect(made.fake.commands().filter((command) => command['type'] === 'prompt')).toHaveLength(1);
  });

  it('blocks a request it cannot read, instead of leaving the call waiting', async () => {
    const made = await piRig({ captures: ['gate-allow'], swap: { '{"v":1': '{"v":9' } });
    rigs.push(made);
    const id = await made.harness.createSession('t');
    await made.harness.prompt(id, 'go');
    await made.waitFor((event) => event.type === 'execution.ended');

    expect(made.events.some((event) => event.type === 'permission.asked')).toBe(false);
    const answers = made.fake.commands().filter((command) => command['type'] === 'extension_ui_response');
    expect(answers).toHaveLength(1);
    expect(JSON.parse(String(answers[0]?.['value']))).toMatchObject({ allow: false });
  });

  it('cancels a call still waiting when the turn is stopped, and refuses a late answer', async () => {
    const made = await piRig({ captures: ['gate-allow', 'abort'] });
    rigs.push(made);
    const id = await made.harness.createSession('t');
    await made.harness.prompt(id, 'go');
    const asking = (await made.waitFor((event) => event.type === 'permission.asked')) as EventOf<'permission.asked'>;

    await made.harness.interrupt(id);
    await made.waitFor((event) => event.type === 'execution.ended');
    await until(() => made.fake.commands().some((command) => command['type'] === 'extension_ui_response'));

    expect(made.fake.commands().filter((command) => command['type'] === 'extension_ui_response')).toEqual([
      expect.objectContaining({ id: asking.id, cancelled: true }),
    ]);
    await expect(made.harness.replyPermission(id, asking.id, 'once')).rejects.toMatchObject({ status: 404 });
  });

  it('loses the call with the process: the turn fails and no answer can be given', async () => {
    const made = await piRig({ captures: ['gate-allow'], exitAfter: 'extension_ui_request' });
    rigs.push(made);
    const id = await made.harness.createSession('t');
    await made.harness.prompt(id, 'go');
    const asking = (await made.waitFor((event) => event.type === 'permission.asked')) as EventOf<'permission.asked'>;
    const ended = (await made.waitFor((event) => event.type === 'execution.ended')) as EventOf<'execution.ended'>;

    expect(ended.outcome).toBe('failed');
    await expect(made.harness.replyPermission(id, asking.id, 'once')).rejects.toMatchObject({ status: 404 });
  });

  it('never runs a call the loop does not answer: the watchdog ends the turn, and the call stays blocked', async () => {
    const made = await piRig({ captures: ['gate-allow', 'abort'] });
    rigs.push(made);
    const config: Config = ConfigSchema.parse({ ...made.config, timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 0 } });
    // The loop made deaf: its answers to the call go nowhere.
    const deaf = Object.create(made.harness, { replyPermission: { value: async () => undefined } }) as typeof made.harness;
    const result = await runIteration({
      harness: deaf,
      config,
      prompt: 'x',
      title: 't',
      logger: quietLogger,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('timeout');
    // pi was told to stop, and nothing but a cancel was ever written for the call.
    const answers = made.fake.commands().filter((command) => command['type'] === 'extension_ui_response');
    expect(answers.every((answer) => answer['cancelled'] === true)).toBe(true);
    expect(made.events.some((event) => event.type === 'tool.finished' && event.status === 'success')).toBe(false);
  });
});
