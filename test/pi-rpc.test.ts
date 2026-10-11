import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/report/logger.js';
import { PiCommandError, PiProcess } from '../src/pi/rpc.js';
import type { PiFrame } from '../src/pi/frames.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WriteStream });

const started: PiProcess[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((process) => process.stop()));
});

/** A child that runs `script` where pi would be. */
function child(script: string): PiProcess {
  const process = PiProcess.spawn({ binary: globalThis.process.execPath, args: ['-e', script], cwd: globalThis.process.cwd(), shutdownTimeoutMs: 2_000, logger });
  started.push(process);
  return process;
}

/** Answers every command with success, echoing its id and type. */
const ANSWERS = `
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
      const command = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (command.type === 'refuse') console.log(JSON.stringify({ id: command.id, type: 'response', command: 'refuse', success: false, error: 'Model not found: a/b' }));
      else if (command.type !== 'silent') console.log(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data: { echoed: command } }));
    }
  });
`;

const frames = (process: PiProcess) => {
  const seen: PiFrame[] = [];
  process.onFrame((frame) => seen.push(frame));
  return seen;
};

describe('PiProcess', () => {
  it('matches each response to its command by id, whatever order they come back in', async () => {
    const pi = child(ANSWERS);
    const [a, b] = await Promise.all([pi.request({ type: 'get_state' }), pi.request({ type: 'get_commands' })]);
    expect(a.command).toBe('get_state');
    expect(b.command).toBe('get_commands');
    expect((a.data as { echoed: { id: string } }).echoed.id).not.toBe((b.data as { echoed: { id: string } }).echoed.id);
  });

  it('turns success: false into a 400 error that carries pi\'s message', async () => {
    const pi = child(ANSWERS);
    const refused = await pi.request({ type: 'refuse' }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(PiCommandError);
    expect(refused).toMatchObject({ status: 400, message: 'Model not found: a/b' });
  });

  it('passes events on and keeps responses to itself', async () => {
    const pi = child(`
      console.log(JSON.stringify({ type: 'agent_start' }));
      process.stdin.on('data', () => console.log(JSON.stringify({ type: 'response', id: 'ralph-1', command: 'x', success: true })));
    `);
    const seen = frames(pi);
    await pi.request({ type: 'x' });
    expect(seen.map((frame) => frame.type)).toEqual(['agent_start']);
  });

  it('splits records on LF only: a U+2028 inside a string does not end the record', async () => {
    const pi = child(`console.log(JSON.stringify({ type: 'message_end', text: 'one\\u2028two\\u2029three' }));`);
    const seen = frames(pi);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([{ type: 'message_end', text: 'one two three' }]);
  });

  it('puts together a record that arrives in pieces, with CRLF endings, and skips lines that are not JSON', async () => {
    const pi = child(`
      process.stdout.write('{"type":"a",');
      setTimeout(() => process.stdout.write('"n":1}\\r\\nnot json\\n{"type":"b"}\\n'), 50);
    `);
    const seen = frames(pi);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toEqual([{ type: 'a', n: 1 }, { type: 'b' }]);
  });

  it('does not split a multi-byte character that arrives in two chunks', async () => {
    const pi = child(`
      const line = Buffer.from(JSON.stringify({ type: 'a', text: '\\u00e9\\u4e2d' }) + '\\n');
      const cut = line.indexOf(0xc3) + 1;
      process.stdout.write(line.subarray(0, cut));
      setTimeout(() => process.stdout.write(line.subarray(cut)), 50);
    `);
    const seen = frames(pi);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toEqual([{ type: 'a', text: 'é中' }]);
  });

  it('rejects commands waiting on a process that exits, saying how and what it printed', async () => {
    const pi = child(`console.error('segfault in model loader'); process.stdin.once('data', () => process.exit(3));`);
    const failed = await pi.request({ type: 'prompt' }).catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(PiCommandError);
    expect(failed).toMatchObject({ status: 503 });
    expect((failed as Error).message).toMatch(/exited \(code 3\) before it answered prompt: segfault in model loader/);
    // And later commands fail at once.
    await expect(pi.request({ type: 'get_state' })).rejects.toMatchObject({ status: 503 });
  });

  it('reports the exit to handlers, including one added after it', async () => {
    const pi = child(`console.error('bye'); process.exit(2);`);
    const exit = await new Promise<{ code: number | null; stderr: string }>((resolve) => pi.onExit(resolve));
    expect(exit).toMatchObject({ code: 2, stderr: 'bye' });
    expect(await new Promise((resolve) => pi.onExit(resolve))).toMatchObject({ code: 2 });
  });

  it('gives up on a command pi does not answer', async () => {
    const pi = child(ANSWERS);
    await expect(pi.request({ type: 'silent' }, 150)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('within 150ms') });
  });

  it('stops the process by closing its stdin, and by signal when it does not go', async () => {
    const polite = child(`process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
    await polite.stop();
    expect(polite.exit).toMatchObject({ code: 0 });

    const stubborn = PiProcess.spawn({
      binary: globalThis.process.execPath,
      args: ['-e', `process.stdin.resume(); setInterval(() => {}, 1000);`],
      cwd: globalThis.process.cwd(),
      shutdownTimeoutMs: 300,
      logger,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stubborn.stop();
    expect(stubborn.exit).toMatchObject({ signal: 'SIGTERM' });
  });

  it('reports a binary that does not exist as an exit', async () => {
    const pi = PiProcess.spawn({ binary: '/nonexistent/pi', args: [], cwd: globalThis.process.cwd(), shutdownTimeoutMs: 500, logger });
    await expect(pi.request({ type: 'get_state' })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('ENOENT') });
  });
});
