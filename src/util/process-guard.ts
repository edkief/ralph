import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

/**
 * Keeping a spawned agent process from outliving Ralph: the guard process and
 * the stop sequence that `opencode serve` and `pi --mode rpc` share.
 */

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
export function stopWhenParentDies(child: ChildProcess, graceMs: number): () => void {
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

export async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
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
