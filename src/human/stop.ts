import { resolve } from 'node:path';
import { commitRecords } from '../loop/records.js';
import { pushBranch } from '../loop/push.js';
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

  if (config.git.records !== 'never') {
    const records = await commitRecords({
      projectRoot: config.projectRoot,
      ralphDir: config.ralphDir,
      subject: 'chore(ralph): record, parked',
      ...(run ? { runId: run.runId } : {}),
    });
    if (records.error) output.write(`Could not commit Ralph's records: ${records.error}\n`);
    else if (records.committed) output.write(`Committed Ralph's records (${records.files.length} file${records.files.length === 1 ? '' : 's'}).\n`);
  }
  const pushed = await pushBranch(config.projectRoot, config.git.remote, config.git.pushTimeoutMs);
  if (!pushed.ok) {
    output.write(`Could not push to ${config.git.remote}: ${pushed.error}\n`);
    return ExitCode.ConfigError;
  }
  output.write(`Pushed to ${config.git.remote}. Nothing was running; uncommitted work outside Ralph's records stays as it is.\n`);
  return 0;
}
