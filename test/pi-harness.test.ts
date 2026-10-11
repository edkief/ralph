import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventOf } from '../src/harness/events.js';
import { HarnessApiError } from '../src/harness/types.js';
import { GATE_EXTENSION } from '../src/pi/gate.js';
import { piRig, type PiRig } from './helpers/pi-harness.js';

const rigs: PiRig[] = [];
async function rig(...args: Parameters<typeof piRig>): Promise<PiRig> {
  const made = await piRig(...args);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((made) => made.close()));
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !condition()) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  return condition();
};
const ended = (event: { type: string }) => event.type === 'execution.ended';
const sent = (made: PiRig, type: string) => made.fake.commands().filter((command) => command['type'] === type);

describe('PiHarness: what it declares', () => {
  it('claims steering, permission asks and skills, and nothing it cannot do: no forms or subagents', async () => {
    const { harness } = await rig();
    expect(harness.name).toBe('pi');
    expect(harness.capabilities).toEqual({ steering: true, forms: false, permissionAsks: true, subagents: false, skills: true });
  });

  it('refuses replies to what pi never asks, and has no parent sessions', async () => {
    const { harness } = await rig();
    await expect(harness.replyPermission('ses_none', 'req_1', 'once')).rejects.toMatchObject({ status: 404 });
    await expect(harness.replyPermission('ses_none', 'req_1', 'reject', 'no')).rejects.toBeInstanceOf(HarnessApiError);
    await expect(harness.replyForm()).rejects.toMatchObject({ status: 404 });
    await expect(harness.cancelForm()).rejects.toMatchObject({ status: 404 });
    expect(await harness.parentOf()).toBeUndefined();
  });
});

describe('PiHarness: sessions', () => {
  it('starts a pi process per session, in the project, with its files under the Ralph folder', async () => {
    const made = await rig({}, { pi: { thinking: 'low', args: ['--provider', 'stub'] } });
    const first = await made.harness.createSession('first');
    const second = await made.harness.createSession('second');

    expect(first).not.toBe(second);
    const starts = made.fake.starts();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual([
      '--mode', 'rpc',
      '--session-dir', resolve(made.projectRoot, '.ralph/history/pi'),
      '--extension', GATE_EXTENSION,
      '--thinking', 'low',
      '--provider', 'stub',
    ]);
    expect(new Set(made.fake.processes().map((p) => p.pid)).size).toBe(2);
    expect(made.fake.processes()[0]?.cwd).toBe(made.projectRoot);
    await until(() => made.events.filter((event) => event.type === 'session.started').length === 2);
    expect(made.events.filter((event) => event.type === 'session.started').map((event) => event.session)).toEqual([first, second]);
    expect(sent(made, 'set_session_name').map((command) => command['name'])).toEqual(expect.arrayContaining(['first', 'second']));
  });

  it('runs a prompt to the end of the execution, with the events tagged with the session', async () => {
    const made = await rig({ captures: ['tool-turn'] });
    const session = await made.harness.createSession('t');
    await made.harness.prompt(session, 'Run echo hello then finish.');

    const last = (await made.waitFor(ended)) as EventOf<'execution.ended'>;
    expect(last.outcome).toBe('succeeded');
    const mine = made.events.filter((event) => event.type !== 'session.started');
    expect(mine.every((event) => event.session === session)).toBe(true);
    expect(mine.map((event) => event.type)).toContain('tool.finished');
    expect(sent(made, 'prompt')).toEqual([expect.objectContaining({ message: 'Run echo hello then finish.' })]);
  });

  it('keeps sessions apart: each one is its own process with its own turn', async () => {
    const made = await rig({ captures: ['tool-turn'] });
    const a = await made.harness.createSession('a');
    const b = await made.harness.createSession('b');
    await made.harness.prompt(a, 'one');
    await made.waitFor((event) => ended(event) && event.session === a);
    expect(made.events.some((event) => event.session === b && event.type !== 'session.started')).toBe(false);
    expect(made.fake.starts()).toHaveLength(2);
  });

  it('refuses a session it never opened', async () => {
    const made = await rig();
    const missing = made.harness.prompt('00000000-0000-0000-0000-000000000000', 'hello');
    await expect(missing).rejects.toBeInstanceOf(HarnessApiError);
    await expect(missing).rejects.toMatchObject({ status: 404 });
  });
});

describe('PiHarness: prompts', () => {
  it('steers a busy session and prompts an idle one, since a steer to an idle pi only waits for the next prompt', async () => {
    const made = await rig({ captures: ['steer', 'tool-turn'] });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'Run the slow thing.');
    await made.waitFor((event) => event.type === 'tool.called');

    await made.harness.prompt(session, 'Wrap up now.', { delivery: 'steer' });
    await made.waitFor(ended);
    expect(sent(made, 'steer')).toEqual([expect.objectContaining({ message: 'Wrap up now.' })]);

    // Idle again: the same delivery is a plain prompt.
    await made.harness.prompt(session, 'And once more.', { delivery: 'steer' });
    expect(sent(made, 'steer')).toHaveLength(1);
    expect(sent(made, 'prompt').map((command) => command['message'])).toEqual(['Run the slow thing.', 'And once more.']);
  });

  it('queues a plain prompt to a busy session behind the turn', async () => {
    const made = await rig({ captures: ['steer'] });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'first');
    await made.waitFor((event) => event.type === 'tool.called');
    await made.harness.prompt(session, 'second');
    expect(sent(made, 'prompt')[1]).toMatchObject({ message: 'second', streamingBehavior: 'followUp' });
  });

  it('switches model before the prompt that wants it, once', async () => {
    const made = await rig(
      { captures: ['tool-turn', 'tool-turn'], models: [{ provider: 'stub', id: 'stub-model' }, { provider: 'local', id: 'qwen/30b' }] },
    );
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'one', { model: 'local/qwen/30b' });
    await made.waitFor(ended);
    expect(made.fake.commands().filter((c) => ['set_model', 'prompt'].includes(String(c['type']))).map((c) => c['type'])).toEqual(['set_model', 'prompt']);
    expect(sent(made, 'set_model')[0]).toMatchObject({ provider: 'local', modelId: 'qwen/30b' });

    await made.harness.prompt(session, 'two', { model: 'local/qwen/30b' });
    expect(sent(made, 'set_model')).toHaveLength(1);
  });

  it('turns a model pi does not have into a 400 that says so, and a malformed one likewise', async () => {
    const made = await rig();
    const session = await made.harness.createSession('s');
    await expect(made.harness.prompt(session, 'x', { model: 'stub/nope' })).rejects.toMatchObject({ status: 400, message: 'Model not found: stub/nope' });
    await expect(made.harness.prompt(session, 'x', { model: 'nope' })).rejects.toMatchObject({ status: 400 });
    expect(sent(made, 'prompt')).toHaveLength(0);
  });

  it('stops a running turn with abort, and the turn ends aborted', async () => {
    const made = await rig({ captures: ['abort'] });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'slow');
    await made.waitFor((event) => event.type === 'tool.called');
    await made.harness.interrupt(session);

    const last = (await made.waitFor(ended)) as EventOf<'execution.ended'>;
    expect(last.outcome).toBe('aborted');
    expect(sent(made, 'abort')).toHaveLength(1);
  });

  it('has nothing to interrupt in a session whose process is gone', async () => {
    const made = await rig();
    await expect(made.harness.interrupt('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });
});

describe('PiHarness: dialogs from extensions', () => {
  it('cancels a question a pi extension asks, so the tool waiting on it carries on', async () => {
    const made = await rig({ captures: ['extension-dialog'] });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'run it');

    const last = (await made.waitFor(ended)) as EventOf<'execution.ended'>;
    expect(last.outcome).toBe('succeeded');
    const answers = sent(made, 'extension_ui_response');
    expect(answers).toEqual([expect.objectContaining({ cancelled: true })]);
    expect(typeof answers[0]?.['id']).toBe('string');
  });
});

describe('PiHarness: processes', () => {
  it('stops the process of a quiet session, and continues the session in a new one from its file', async () => {
    const made = await rig({ captures: ['tool-turn', 'tool-turn'] }, {}, { idleMs: 150 });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'first');
    await made.waitFor(ended);

    const [first] = made.fake.processes();
    await until(() => !alive(first!.pid));
    expect(alive(first!.pid)).toBe(false);

    await made.harness.prompt(session, 'second');
    await until(() => made.events.filter(ended).length === 2);

    expect(made.fake.processes()).toHaveLength(2);
    const [switched] = sent(made, 'switch_session');
    expect(String(switched?.['sessionPath'])).toMatch(new RegExp(`\\.ralph/history/pi/.+_${session}\\.jsonl$`));
    expect(existsSync(String(switched?.['sessionPath']))).toBe(true);
    // The switch comes before the prompt that continues the session.
    const order = made.fake.commands().map((command) => command['type']);
    expect(order.indexOf('switch_session')).toBeLessThan(order.lastIndexOf('prompt'));
  });

  it('does not stop a session that is working, however long it takes', async () => {
    const made = await rig({ captures: ['steer'] }, {}, { idleMs: 100 });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'Run the slow thing.');
    await made.waitFor((event) => event.type === 'tool.called');
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    expect(alive(made.fake.processes()[0]!.pid)).toBe(true);
  });

  it('ends the execution as failed, with what pi printed, when the process dies mid-turn', async () => {
    const made = await rig({ captures: ['tool-turn'], exitAfter: 'tool_execution_start' });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'go');

    const last = (await made.waitFor(ended)) as EventOf<'execution.ended'>;
    expect(last).toMatchObject({ outcome: 'failed', session });
    expect(last.error).toMatch(/pi exited \(code 7\)/);
  });

  it('reports a prompt pi dies on as an error to the caller', async () => {
    const made = await rig({ exitOnPrompt: 3 });
    const session = await made.harness.createSession('s');
    await expect(made.harness.prompt(session, 'go')).rejects.toMatchObject({ status: 503 });
  });

  it('kills every process on stop(), and refuses new sessions after', async () => {
    const made = await rig();
    await made.harness.createSession('a');
    await made.harness.createSession('b');
    const pids = made.fake.processes().map((p) => p.pid);
    expect(pids.every(alive)).toBe(true);

    await made.harness.stop();
    expect(await until(() => pids.every((pid) => !alive(pid)))).toBe(true);
    await expect(made.harness.createSession('c')).rejects.toMatchObject({ status: 503 });
  });
});

/** A stand-in for playwright-cli that appends its arguments to a file, one line per run. */
function recordingCli(): { binary: string; runs(): string[] } {
  const dir = mkdtempSync(resolve(tmpdir(), 'ralph-browser-cli-'));
  const binary = resolve(dir, 'playwright-cli');
  const log = resolve(dir, 'runs.txt');
  writeFileSync(binary, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
  chmodSync(binary, 0o755);
  return { binary, runs: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

describe('PiHarness: closing the browser (pi.closeBrowser)', () => {
  it('is off by default: no session name, and playwright-cli is never run', async () => {
    const cli = recordingCli();
    const made = await rig({}, {}, { browserCli: cli.binary });
    await made.harness.createSession('s');
    await made.harness.stop();
    expect(made.fake.browserSessions()).toEqual([undefined]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(cli.runs()).toEqual([]);
  });

  it('gives each process a session name of its own, and closes that session when the process stops', async () => {
    const cli = recordingCli();
    const made = await rig({}, { pi: { closeBrowser: true } }, { browserCli: cli.binary });
    await made.harness.createSession('a');
    await made.harness.createSession('b');
    const names = made.fake.browserSessions();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^ralph-[0-9a-f]{8}$/);
    expect(names[1]).not.toBe(names[0]);

    await made.harness.stop();
    expect(await until(() => cli.runs().length === 2)).toBe(true);
    expect(cli.runs().sort()).toEqual(names.map((name) => `-s=${name} close`).sort());
  });

  it('closes the session of a process stopped for being quiet, and the one that continues the session has a new name', async () => {
    const cli = recordingCli();
    const made = await rig({ captures: ['tool-turn', 'tool-turn'] }, { pi: { closeBrowser: true } }, { idleMs: 150, browserCli: cli.binary });
    const session = await made.harness.createSession('s');
    await made.harness.prompt(session, 'first');
    await made.waitFor(ended);
    await until(() => cli.runs().length === 1);
    const [first] = made.fake.browserSessions();
    expect(cli.runs()).toEqual([`-s=${first} close`]);

    await made.harness.prompt(session, 'second');
    await until(() => made.events.filter(ended).length === 2);
    const [, second] = made.fake.browserSessions();
    expect(second).toMatch(/^ralph-/);
    expect(second).not.toBe(first);
  });

  it('does not fail a stop, or anything else, when playwright-cli is not there', async () => {
    const made = await rig({}, { pi: { closeBrowser: true } }, { browserCli: '/nonexistent/playwright-cli' });
    await made.harness.createSession('s');
    await expect(made.harness.stop()).resolves.toBeUndefined();
  });
});
