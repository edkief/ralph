import { resolve } from 'node:path';
import { commitRecords, type RecordsMode } from '../loop/records.js';
import { describeDivergence, describeOverwrite, pushBranch } from '../loop/push.js';
import { RalphProject } from '../ui/project.js';
import { requestStop, STOP_MESSAGES, type StopMode } from './request.js';
import { ExitCode } from '../exit.js';
import type { Config } from '../config/schema.js';

/**
 * `ralph stop [--now | --park]`: ask the project's run to stop, from another
 * terminal, as the web UI does. With nothing running, `--park` still hands
 * the project over: Ralph's records are committed and the branch pushed.
 *
 * Exit codes: 0 asked, or parked; 4 nothing to stop, or the push failed.
 */
export async function runStop(args: {
  config: Config;
  mode: StopMode;
  output?: { write(text: string): unknown };
}): Promise<number> {
  const { config, mode } = args;
  const output = args.output ?? process.stdout;
  const project = new RalphProject(config.projectRoot, config.ralphDir);
  const run = project.status().run;

  if (run?.live) {
    requestStop(resolve(config.projectRoot, config.ralphDir), mode, 'cli');
    output.write(`${STOP_MESSAGES[mode]}\n`);
    return 0;
  }
  if (mode !== 'park') {
    output.write('Nothing is running to stop.\n');
    return ExitCode.ConfigError;
  }

  const parked = await parkIdle({
    projectRoot: config.projectRoot,
    ralphDir: config.ralphDir,
    records: config.git.records,
    remote: config.git.remote,
    pushTimeoutMs: config.git.pushTimeoutMs,
    forcePush: config.git.forcePush,
    ...(run ? { runId: run.runId } : {}),
  });
  for (const line of parked.lines) output.write(`${line}\n`);
  return parked.ok ? 0 : parked.diverged ? ExitCode.PushRejected : ExitCode.ConfigError;
}

/**
 * Park a project with nothing running: commit Ralph's records (unless
 * `git.records` is `never`) and push the branch. Shared by `ralph stop --park`
 * and the web UI's Park button.
 */
export async function parkIdle(args: {
  projectRoot: string;
  ralphDir: string;
  records: RecordsMode;
  remote: string;
  pushTimeoutMs: number;
  /** Overwrite a remote branch that has diverged, keeping a backup of it. */
  forcePush?: boolean;
  /** The latest run, whose journal is brought up to date. */
  runId?: string;
}): Promise<{ ok: boolean; lines: string[]; /** The push was rejected: the remote branch has diverged. */ diverged?: boolean }> {
  const lines: string[] = [];
  if (args.records !== 'never') {
    const records = await commitRecords({
      projectRoot: args.projectRoot,
      ralphDir: args.ralphDir,
      subject: 'chore(ralph): record, parked',
      ...(args.runId ? { runId: args.runId } : {}),
    });
    if (records.error) lines.push(`Could not commit Ralph's records: ${records.error}`);
    else if (records.committed) lines.push(`Committed Ralph's records (${records.files.length} file${records.files.length === 1 ? '' : 's'}).`);
  }
  const pushed = await pushBranch(args.projectRoot, args.remote, args.pushTimeoutMs, { force: args.forcePush ?? false });
  if (!pushed.ok) {
    if (!pushed.diverged) {
      lines.push(`Could not push to ${args.remote}: ${pushed.error}`);
      return { ok: false, lines };
    }
    lines.push(...describeDivergence(pushed.diverged));
    return { ok: false, lines, diverged: true };
  }
  if (pushed.overwritten) lines.push(...describeOverwrite(pushed.overwritten));
  lines.push(`Pushed to ${args.remote}. Nothing was running; uncommitted work outside Ralph's records stays as it is.`);
  return { ok: true, lines };
}
