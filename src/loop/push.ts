import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type PushResult = { ok: true } | { ok: false; error: string };

/**
 * Push the current branch to the same-named branch on `remote`.
 *
 * The loop pushes, not the agent: the agent keeps its `git push` deny rule, so
 * it can never force-push or rewrite remotes. Never forced, and never prompts
 * for credentials — an unattended run must fail fast rather than hang.
 */
export async function pushBranch(cwd: string, remote: string, timeoutMs: number): Promise<PushResult> {
  try {
    await run('git', ['push', remote, 'HEAD'], {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true };
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    return { ok: false, error: (error.stderr || error.message).trim() };
  }
}
