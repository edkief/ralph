import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { OpencodeClient } from './client.js';
import type { ServerConfig } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

export class ServerStartError extends Error {}

export interface ServerHandle {
  client: OpencodeClient;
  /** Stops the server when Ralph owns it; a no-op in attach mode. */
  stop(): Promise<void>;
}

const PASSWORD_PATTERN = /server password (\S+)/;
const LISTENING_PATTERN = /listening on (\S+)/;

/**
 * Attach to an existing opencode server, or spawn one Ralph owns.
 *
 * Spawning is preferred for unattended runs: the server prints its generated
 * password on stdout at startup, so credentials are captured deterministically
 * instead of being scraped out of `opencode pair`.
 *
 * A spawned server is an ordinary child in Ralph's process group: the
 * terminal's Ctrl-C and hangup reach it as they reach Ralph.
 */
export async function startServer(
  config: ServerConfig,
  options: { cwd: string; logger: Logger },
): Promise<ServerHandle> {
  if (config.url) {
    const client = new OpencodeClient({
      baseUrl: config.url,
      ...(config.password ? { password: config.password } : {}),
    });
    await waitForHealth(client, config.startupTimeoutMs);
    options.logger.info('attached to opencode server', { url: config.url });
    return { client, stop: async () => undefined };
  }

  const args = ['serve', '--hostname', config.hostname, '--port', String(config.port)];
  const child = spawn('opencode', args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  // A child is not stopped by its parent ending: not by an exit that skips
  // stop(), and not by a crash, which runs no exit hook either.
  const killOnExit = () => child.kill('SIGTERM');
  process.once('exit', killOnExit);
  const disarm = stopWhenParentDies(child, config.shutdownTimeoutMs);
  child.once('exit', () => {
    process.off('exit', killOnExit);
    disarm();
  });

  const { url, password } = await readStartupBanner(child, config.startupTimeoutMs, options.logger);
  const client = new OpencodeClient({ baseUrl: url, password });
  await waitForHealth(client, config.startupTimeoutMs);
  options.logger.info('started opencode server', { url, pid: child.pid ?? null });

  return {
    client,
    stop: () => stopChild(child, config.shutdownTimeoutMs),
  };
}

/**
 * What the guard process runs: wait for stdin to end, which it does when the
 * process holding the other end of the pipe is gone, then stop `pid`.
 */
export function guardScript(pid: number, graceMs: number): string {
  return `
    const alive = () => { try { process.kill(${pid}, 0); return true; } catch { return false; } };
    const signal = (name) => { try { process.kill(${pid}, name); } catch {} };
    process.stdin.resume();
    process.stdin.on('error', () => {});
    process.stdin.on('close', () => {
      signal('SIGTERM');
      const deadline = Date.now() + ${graceMs};
      setInterval(() => {
        if (!alive()) process.exit(0);
        if (Date.now() < deadline) return;
        signal('SIGKILL');
        process.exit(0);
      }, 100);
    });
  `;
}

/**
 * Have `child` stopped when this process dies without stopping it: killed, or
 * aborted by V8 when the heap is full. Nothing runs here then, so a small
 * guard process holds a pipe from this one and acts when it closes. Returns
 * a function that calls the guard off.
 */
function stopWhenParentDies(child: ChildProcess, graceMs: number): () => void {
  if (child.pid === undefined) return () => undefined;
  // In a process group of its own: a Ctrl-C that kills Ralph must not kill the guard first.
  const guard = spawn(process.execPath, ['-e', guardScript(child.pid, graceMs)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  guard.on('error', () => undefined);
  guard.stdin?.on('error', () => undefined);
  // Neither the guard nor its pipe should keep Ralph running.
  guard.unref();
  (guard.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null)?.unref?.();
  return () => {
    guard.kill('SIGKILL');
  };
}

/**
 * Read the server's startup lines until both the listening URL and the
 * generated password have been seen.
 */
async function readStartupBanner(
  child: ChildProcess,
  timeoutMs: number,
  logger: Logger,
): Promise<{ url: string; password: string }> {
  return new Promise((resolve, reject) => {
    let url: string | undefined;
    let password: string | undefined;
    let stderr = '';

    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new ServerStartError(`opencode serve did not start within ${timeoutMs}ms`));
    }, timeoutMs);

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      logger.debug('opencode serve', { line: text.trim() });
      url ??= text.match(LISTENING_PATTERN)?.[1];
      password ??= text.match(PASSWORD_PATTERN)?.[1];
      if (url && password) {
        cleanup();
        resolve({ url, password });
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new ServerStartError(
          `opencode serve exited with code ${code} before it was ready.\n${stderr.slice(-2000)}`,
        ),
      );
    };

    const onError = (cause: Error) => {
      cleanup();
      reject(new ServerStartError(`Could not run \`opencode\`: ${cause.message}`));
    };

    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForHealth(client: OpencodeClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.health();
      return;
    } catch (cause) {
      lastError = cause;
      await sleep(250);
    }
  }
  throw new ServerStartError(
    `opencode server at ${client.url} never became healthy: ${(lastError as Error)?.message ?? 'unknown error'}`,
  );
}

async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
