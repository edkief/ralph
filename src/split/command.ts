import { startServer } from '../opencode/server.js';
import { applySplit, proposeSplit, readProposal, splitDir, SplitError, type Split } from '../loop/split.js';
import { ConsoleReporter, truncate } from '../report/console.js';
import { TaskStore } from '../tasks/store.js';
import { ExitCode } from '../exit.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

/**
 * `ralph split <task> [--apply]`: show the split proposed for a task, having
 * the agent propose one first if there is none, and with `--apply` replace the
 * task with the proposed ones and commit that.
 *
 * Exit codes: 0 proposed or applied, 4 no such task or a proposal with
 * problems, 5 the agent could not propose one, 6 the agent advises against
 * splitting, 130 interrupted.
 */
export async function runSplit(args: {
  config: Config;
  logger: Logger;
  taskId: string | undefined;
  apply: boolean;
  reporter?: ConsoleReporter;
}): Promise<number> {
  const { config, logger, taskId } = args;
  const reporter = args.reporter ?? new ConsoleReporter();
  if (!taskId) {
    reporter.summary('Which task?', ['Usage: ralph split <TASK-ID> [--apply]'], 'bad');
    return ExitCode.ConfigError;
  }

  const dir = splitDir(config.ralphDir, taskId);
  const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
  let read = readProposal(config.projectRoot, config.ralphDir, taskId, tasks);

  if (read.status === 'ok' && read.proposal.appliedAt) {
    const into = read.proposal.splittable ? read.proposal.tasks.map((child) => child.id).join(', ') : 'nothing';
    reporter.summary(`${taskId} was already split`, [`Into ${into}, on ${read.proposal.appliedAt}. The record is in ${dir}/.`], 'good');
    return ExitCode.Complete;
  }

  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.passes) {
    reporter.summary(`Cannot split ${taskId}`, [task ? `${taskId} already passes.` : `${taskId} is not in tasks.json.`], 'bad');
    return ExitCode.ConfigError;
  }

  if (read.status === 'invalid') {
    reporter.summary(
      `The proposal in ${dir}/ has problems`,
      [...read.problems, '', `Fix them, or delete ${dir}/ to have the agent propose a new split.`],
      'bad',
    );
    return ExitCode.ConfigError;
  }

  if (read.status === 'missing') {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.on('SIGINT', onInterrupt);
    const server = await startServer(config.server, { cwd: config.projectRoot, logger });
    try {
      reporter.banner([`ralph split · ${taskId}`, `  asking ${config.plan.model ?? config.model ?? 'the server default model'} to propose a split`]);
      const outcome = await proposeSplit({
        client: server.client,
        config,
        logger,
        taskId,
        cutShort: [],
        signal: controller.signal,
        hooks: {
          onText: (text) => reporter.status(truncate(text, 100)),
          onTool: (tool, detail) => reporter.status(`${tool} ${detail}`),
        },
      });
      reporter.clearStatus();
      if (controller.signal.aborted) {
        reporter.summary('■ Interrupted', [`Anything the agent wrote is in ${dir}/.`], 'warn');
        return ExitCode.Interrupted;
      }
      if (outcome.status === 'failed') {
        reporter.summary('Could not propose a split', [outcome.reason], 'bad');
        return ExitCode.ProviderError;
      }
    } finally {
      process.off('SIGINT', onInterrupt);
      await server.stop();
    }
    read = readProposal(config.projectRoot, config.ralphDir, taskId, tasks);
    if (read.status !== 'ok') return ExitCode.ProviderError;
  }

  const proposal = read.proposal;
  if (!proposal.splittable) {
    reporter.summary(
      proposal.retry ? `${taskId} is better attempted again as it is` : `Splitting ${taskId} would not help`,
      [proposal.reason, '', `The advice is in ${dir}/proposal.json. Delete ${dir}/ to have the agent try again.`],
      'warn',
    );
    return ExitCode.Stalled;
  }

  if (!args.apply) {
    reporter.summary(`Proposed split of ${taskId}`, [...describe(proposal, dir), '', `Apply it with \`ralph split ${taskId} --apply\`.`], 'good');
    return ExitCode.Complete;
  }

  try {
    const applied = await applySplit({ projectRoot: config.projectRoot, ralphDir: config.ralphDir, taskId, commit: true });
    reporter.summary(
      `Split ${taskId}`,
      [
        ...describe(proposal, dir),
        '',
        applied.committed
          ? 'Committed. The next run starts on the first new task.'
          : `Applied, but not committed: ${applied.commitError ?? 'unknown error'}. Commit ${config.ralphDir}/ yourself.`,
      ],
      applied.committed ? 'good' : 'warn',
    );
    return ExitCode.Complete;
  } catch (cause) {
    if (!(cause instanceof SplitError)) throw cause;
    reporter.summary(`Could not split ${taskId}`, [cause.message], 'bad');
    return ExitCode.ConfigError;
  }
}

function describe(proposal: Split, dir: string): string[] {
  return [
    ...proposal.tasks.map((child) => `${child.id}  ${child.title}`),
    ...(proposal.reason.trim() ? ['', proposal.reason.trim()] : []),
    '',
    `Specs and proposal: ${dir}/`,
  ];
}
