import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardScript, startServer, type ServerHandle } from '../src/opencode/server.js';
import { Logger } from '../src/report/logger.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WriteStream });
const posix = process.platform !== 'win32';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return condition();
}

const processGroup = (pid: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim();

/** An `opencode` on the PATH that prints the startup banner and answers the health check. */
function fakeOpencode(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ralph-opencode-'));
  const file = resolve(dir, 'opencode');
  writeFileSync(
    file,
    `#!${process.execPath}
const server = require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  console.log('server password secret');
  console.log('listening on http://127.0.0.1:' + server.address().port);
  console.log('pid ' + process.pid);
});
`,
  );
  chmodSync(file, 0o755);
  return dir;
}

const serverConfig = { hostname: '127.0.0.1', port: 0, startupTimeoutMs: 10_000, shutdownTimeoutMs: 2_000 };
const pids: number[] = [];
let handle: ServerHandle | undefined;
const path = process.env['PATH'];

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  process.env['PATH'] = path;
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, as it should be.
    }
  }
});

describe.runIf(posix)('a spawned opencode server', () => {
  it('runs in Ralph’s process group, and stops with stop()', async () => {
    process.env['PATH'] = `${fakeOpencode()}${delimiter}${path}`;
    let pid = 0;
    const capture = new Logger({ level: 'info', stream: { write: () => true } as NodeJS.WriteStream });
    capture.addSink((entry) => {
      if (entry.message === 'started opencode server') pid = Number(entry.fields?.['pid']);
    });
    handle = await startServer(serverConfig, { cwd: process.cwd(), logger: capture });
    expect(pid).toBeGreaterThan(0);
    pids.push(pid);

    expect(processGroup(pid)).toBe(processGroup(process.pid));
    expect(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim()).toBe(String(process.pid));

    await handle.stop();
    handle = undefined;
    expect(alive(pid)).toBe(false);
  });
});

describe.runIf(posix)('the guard on a spawned server', () => {
  /** A stand-in for Ralph: starts a child and its guard, says the child's pid, then waits. */
  const parentScript = (grace: number, childSource: string) => `
    const { spawn } = require('node:child_process');
    const guardScript = ${guardScript.toString()};
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' });
    spawn(process.execPath, ['-e', guardScript(child.pid, ${grace})], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;

  async function startParent(grace: number, childSource: string): Promise<{ parent: number; child: number }> {
    const parent = spawn(process.execPath, ['-e', parentScript(grace, childSource)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const child = await new Promise<number>((resolvePid) => parent.stdout.once('data', (chunk: Buffer) => resolvePid(Number(chunk.toString()))));
    pids.push(parent.pid!, child);
    return { parent: parent.pid!, child };
  }

  it('stops the server when Ralph is killed outright', async () => {
    const { parent, child } = await startParent(2_000, 'setInterval(() => {}, 1000)');
    expect(alive(child)).toBe(true);

    process.kill(parent, 'SIGKILL');
    expect(await until(() => !alive(child))).toBe(true);
  });

  it('kills a server that ignores being asked to stop', async () => {
    const { parent, child } = await startParent(300, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    // Give the child time to install its handler.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    process.kill(parent, 'SIGKILL');
    expect(await until(() => !alive(child))).toBe(true);
  });

  it('leaves the server alone while Ralph lives', async () => {
    const { child } = await startParent(300, 'setInterval(() => {}, 1000)');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    expect(alive(child)).toBe(true);
  });
});
