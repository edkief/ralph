import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakePi, type FakePiOptions } from './helpers/pi.js';

type Line = Record<string, any>;

/** Run the fake as a client would: send commands, collect what it writes until `until` is seen. */
async function drive(options: FakePiOptions, commands: Line[], until: (line: Line) => boolean): Promise<Line[]> {
  const fake = fakePi(options);
  const child = spawn(fake.binary, ['--mode', 'rpc', '--session-dir', mkdtempSync(resolve(tmpdir(), 'ralph-pi-sessions-'))], {
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
  for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
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
