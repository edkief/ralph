import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakePi, type FakePiOptions } from './helpers/pi.js';

type Line = Record<string, any>;

/** Run the fake as a client would: send commands, collect what it writes until `until` is seen. */
async function drive(options: FakePiOptions, commands: Array<Line | ((lines: Line[]) => Line | Promise<Line>)>, until: (line: Line) => boolean, args: string[] = []): Promise<Line[]> {
  const fake = fakePi(options);
  const child = spawn(fake.binary, ['--mode', 'rpc', '--session-dir', mkdtempSync(resolve(tmpdir(), 'ralph-pi-sessions-')), ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines: Line[] = [];
  let buffer = '';
  const done = new Promise<void>((resolveDone) => {
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        lines.push(line);
        if (until(line)) resolveDone();
      }
    });
  });
  // A command may be a function of what the fake has written so far: an answer to a request it made.
  for (const command of commands) child.stdin.write(`${JSON.stringify(typeof command === 'function' ? await command(lines) : command)}\n`);
  await done;
  child.stdin.end();
  return lines;
}

const types = (name: string) =>
  readFileSync(resolve(__dirname, `fixtures/pi/${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.dir === 'out' && record.line.command !== 'get_state')
    .map((record) => record.line.type);

describe('fake pi', () => {
  it('prints a version for --version, on stderr as pi does', async () => {
    const fake = fakePi({ version: '0.99.0' });
    const child = spawn(fake.binary, ['--version'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    child.stderr.on('data', (chunk) => (text += chunk));
    await new Promise((done) => child.on('exit', done));
    expect(text.trim()).toBe('0.99.0');
  });

  it('plays a recorded turn: the recorded events, in order, with the response carrying the command id', async () => {
    const lines = await drive(
      { captures: ['tool-turn'] },
      [{ id: 'mine', type: 'prompt', message: 'go' }],
      (line) => line.type === 'agent_end',
    );
    const response = lines.find((line) => line.type === 'response');
    expect(response).toMatchObject({ id: 'mine', command: 'prompt', success: true });
    expect(lines.map((line) => line.type)).toEqual(types('tool-turn'));
  });

  it('answers state commands in pi\'s shape', async () => {
    const lines = await drive(
      { models: [{ provider: 'local', id: 'qwen' }], skills: ['demo'] },
      [
        { id: 'a', type: 'get_state' },
        { id: 'b', type: 'get_available_models' },
        { id: 'c', type: 'get_commands' },
        { id: 'd', type: 'set_model', provider: 'local', modelId: 'qwen' },
        { id: 'e', type: 'set_model', provider: 'local', modelId: 'nope' },
      ],
      (line) => line.id === 'e',
    );
    const byId = Object.fromEntries(lines.map((line) => [line.id, line]));
    expect(byId['a'].data).toMatchObject({ isStreaming: false, model: null });
    expect(byId['a'].data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(byId['b'].data.models.map((m: Line) => `${m.provider}/${m.id}`)).toEqual(['local/qwen']);
    expect(byId['c'].data.commands.map((c: Line) => c.name)).toEqual(['skill:demo']);
    expect(byId['d']).toMatchObject({ success: true });
    expect(byId['e']).toMatchObject({ success: false, error: 'Model not found: local/nope' });
  });

  it('plays the steer segment only once a steer arrives', async () => {
    const lines = await drive(
      { captures: ['steer'] },
      [
        { id: 'p', type: 'prompt', message: 'slow' },
        { id: 's', type: 'steer', message: 'wrap up' },
      ],
      (line) => line.type === 'agent_end',
    );
    const order = lines.map((line) => line.type);
    expect(order.indexOf('response')).toBeLessThan(order.indexOf('tool_execution_start'));
    expect(order.filter((type) => type === 'response')).toHaveLength(2);
    expect(order.at(-1)).toBe('agent_end');
  });
});

describe('fake pi with the permission gate', () => {
  const GATE = resolve(__dirname, '../extensions/ralph-gate.mjs');
  const ended = (line: Line) => line.type === 'agent_end';

  /** Wait until the fake has put a gate request, then answer it with `body`. */
  const answerGate = (body: Line) => async (lines: Line[]) => {
    for (let waited = 0; waited < 3_000; waited += 20) {
      const request = lines.find((line) => line.type === 'extension_ui_request' && line.title === 'ralph:gate');
      if (request) return { type: 'extension_ui_response', id: request.id, ...body };
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('the fake made no gate request');
  };
  const run = (options: FakePiOptions, body: Line) =>
    drive({ captures: ['gate-allow'], ...options }, [{ id: 'p', type: 'prompt', message: 'go' }, answerGate(body)], ended, ['-e', GATE]);
  const toolEnd = (lines: Line[]) => lines.find((line) => line.type === 'tool_execution_end');

  it('lists the gate command once the extension is on the command line', async () => {
    const lines = await drive({}, [{ id: 'c', type: 'get_commands' }], (line) => line.id === 'c', ['-e', GATE]);
    expect(lines.find((line) => line.id === 'c')?.data.commands).toEqual([expect.objectContaining({ name: 'ralph-gate', source: 'extension' })]);
  });

  it('lists nothing without it, or when it fails to load, or when the file is not there', async () => {
    const commands = async (options: FakePiOptions, args: string[]) =>
      (await drive(options, [{ id: 'c', type: 'get_commands' }], (line) => line.id === 'c', args)).find((line) => line.id === 'c')?.data.commands;
    expect(await commands({}, [])).toEqual([]);
    expect(await commands({ gate: 'missing' }, ['-e', GATE])).toEqual([]);
    expect(await commands({}, ['-e', '/nowhere/ralph-gate.mjs'])).toEqual([]);
    expect(await commands({}, ['--extension', '/other/extension.ts'])).toEqual([]);
  });

  it('puts the tool call to the client and waits for the answer before the tool runs', async () => {
    const lines = await run({ swap: { 'echo hello': 'git push origin main' } }, { value: '{"allow":true}' });
    const request = lines.find((line) => line.type === 'extension_ui_request');
    expect(request).toMatchObject({ method: 'input', title: 'ralph:gate' });
    expect(JSON.parse(request?.placeholder)).toEqual({ v: 1, id: 'call_1', tool: 'bash', input: { command: 'git push origin main' } });
    const order = lines.map((line) => line.type);
    expect(order.indexOf('extension_ui_request')).toBeGreaterThan(order.indexOf('tool_execution_start'));
    expect(order.indexOf('extension_ui_request')).toBeLessThan(order.indexOf('tool_execution_end'));
    expect(toolEnd(lines)).toMatchObject({ isError: false });
  });

  it('blocks the call with the reason it was answered with', async () => {
    const lines = await run({}, { value: JSON.stringify({ allow: false, reason: 'it matches the deny rule "rm -rf /"' }) });
    expect(toolEnd(lines)).toMatchObject({ isError: true, result: { content: [{ text: 'it matches the deny rule "rm -rf /"' }] } });
  });

  it('blocks it when the request is cancelled, and when the answer is not a yes', async () => {
    expect(toolEnd(await run({}, { cancelled: true }))).toMatchObject({ isError: true });
    expect(toolEnd(await run({}, { value: 'yes' }))).toMatchObject({ isError: true });
  });

  it('never runs the tool while the request is unanswered', async () => {
    const lines = await drive(
      { captures: ['gate-allow'] },
      [{ id: 'p', type: 'prompt', message: 'go' }],
      (line) => line.type === 'extension_ui_request',
      ['-e', GATE],
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(lines.map((line) => line.type)).not.toContain('tool_execution_end');
  });

  it('gives each request an id of its own', async () => {
    const first = (await run({}, { value: '{"allow":true}' })).find((line) => line.type === 'extension_ui_request');
    const second = (await run({}, { value: '{"allow":true}' })).find((line) => line.type === 'extension_ui_request');
    expect(first?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
  });
});
