import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessTask } from '../src/loop/assess.js';
import { runEscalation } from '../src/loop/escalate.js';
import { runIteration } from '../src/loop/iteration.js';
import { proposeSplit } from '../src/loop/split.js';
import type { Task } from '../src/tasks/store.js';
import type { FakePiOptions } from './helpers/pi.js';
import { piRig, quietLogger, type PiRig } from './helpers/pi-harness.js';

/**
 * The turns around the loop's own, each on a pi of its own: triage, escalation and a split proposal, which carries on
 * in one session across prompts. They drive the harness interface, so what is shown here is that they work over pi.
 */
const rigs: PiRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((made) => made.close()));
});

async function rig(fake: FakePiOptions, overrides: Record<string, unknown> = {}, idleMs?: number): Promise<PiRig> {
  const made = await piRig(fake, { model: 'stub/stub-model', ...overrides }, idleMs ? { idleMs } : {});
  rigs.push(made);
  const { projectRoot } = made;
  mkdirSync(resolve(projectRoot, '.ralph'), { recursive: true });
  writeFileSync(resolve(projectRoot, '.ralph', 'tasks.json'), JSON.stringify([{ id: 'TASK-1', title: 'Parser', passes: false }]));
  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  return made;
}

const sent = (made: PiRig, type: string) => made.fake.commands().filter((command) => command['type'] === type);
const task: Task = { id: 'TASK-1', title: 'Parser', passes: false } as Task;

describe('assess on pi', () => {
  it('runs the triage turn and reads the estimate from what the model says', async () => {
    const made = await rig({ captures: ['tool-turn'], say: 'About right. <promise>ESTIMATE:90:three separate changes</promise>' });
    const outcome = await assessTask({ harness: made.harness, config: made.config, logger: quietLogger, task, signal: new AbortController().signal });

    expect(outcome.assessment).toMatchObject({ verdict: 'too-big', estimateMinutes: 90, reason: 'three separate changes' });
    expect(outcome.recorded).toBe(true);
    // The session is the one a split turn carries on in.
    expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent(made, 'prompt')).toHaveLength(1);
  });
});

describe('escalation on pi', () => {
  it('runs the escalation turn in a session of its own and reads its answer', async () => {
    const made = await rig({ captures: ['tool-turn'], say: '<promise>RESOLVE:resume:The network is up.</promise>' });
    const outcome = await runEscalation({
      harness: made.harness,
      config: made.config,
      logger: quietLogger,
      runId: '20261004-120000',
      request: { kind: 'blocked', taskId: 'TASK-1', message: 'no network' },
      agentText: '<promise>BLOCKED:no network</promise>',
      decisions: [],
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ status: 'resolved', action: 'resume', text: 'The network is up.' });
  });

  it('asks again in the same session when the answer cannot be acted on', async () => {
    const made = await rig({ captures: ['tool-turn', 'tool-turn'], say: ['I would resume.', '<promise>RESOLVE:resume:Try again.</promise>'] });
    const outcome = await runEscalation({
      harness: made.harness,
      config: made.config,
      logger: quietLogger,
      runId: '20261004-120000',
      request: { kind: 'blocked', taskId: 'TASK-1', message: 'no network' },
      decisions: [],
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({ status: 'resolved', action: 'resume' });
    expect(sent(made, 'prompt')).toHaveLength(2);
    // One session, so one process: the second prompt went to the pi the first did.
    expect(made.fake.starts()).toHaveLength(1);
  });

  it('keeps the escalation turn apart from a turn running beside it', async () => {
    const made = await rig({ captures: ['tool-turn'], say: '<promise>RESOLVE:resume:ok</promise>' });
    const beside = await made.harness.createSession('the loop');
    await runEscalation({
      harness: made.harness,
      config: made.config,
      logger: quietLogger,
      runId: '20261004-120000',
      request: { kind: 'blocked', taskId: 'TASK-1', message: 'no network' },
      decisions: [],
      signal: new AbortController().signal,
    });

    expect(made.fake.starts()).toHaveLength(2);
    expect(made.events.filter((event) => event.session === beside).map((event) => event.type)).toEqual(['session.started']);
  });
});

describe('a split proposal on pi', () => {
  it('sends the agent back to fix a proposal it did not write, in the session it started, until it gives up', async () => {
    const made = await rig({ captures: ['tool-turn', 'tool-turn', 'tool-turn'], say: 'Here is my plan.' });
    const outcome = await proposeSplit({
      harness: made.harness,
      config: made.config,
      logger: quietLogger,
      taskId: 'TASK-1',
      cutShort: [],
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({ status: 'failed', reason: expect.stringContaining('proposal.json was not written') });
    expect(sent(made, 'prompt')).toHaveLength(3);
    expect(made.fake.starts()).toHaveLength(1);
  });
});

describe('carrying a session on', () => {
  it('continues a session in a later turn, as the confirm and split turns do', async () => {
    const made = await rig({ captures: ['tool-turn', 'tool-turn'] });
    const turn = (sessionId?: string) =>
      runIteration({
        harness: made.harness,
        config: made.config,
        prompt: 'go on',
        title: 'turn',
        logger: quietLogger,
        signal: new AbortController().signal,
        ...(sessionId ? { sessionId } : {}),
      });

    const first = await turn();
    const second = await turn(first.sessionId);

    expect(second.sessionId).toBe(first.sessionId);
    expect(made.fake.starts()).toHaveLength(1);
  });

  it('continues it in a new process once the first has been stopped for being quiet, from the session file', async () => {
    const made = await rig({ captures: ['tool-turn', 'tool-turn'] }, {}, 150);
    const turn = (sessionId?: string) =>
      runIteration({
        harness: made.harness,
        config: made.config,
        prompt: 'go on',
        title: 'turn',
        logger: quietLogger,
        signal: new AbortController().signal,
        ...(sessionId ? { sessionId } : {}),
      });

    const first = await turn();
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    const second = await turn(first.sessionId);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.status).toBe('complete');
    expect(made.fake.starts()).toHaveLength(2);
    expect(sent(made, 'switch_session')).toHaveLength(1);
  });
});
