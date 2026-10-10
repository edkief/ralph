import { resolve } from 'node:path';
import { RALPH_DIR } from '../config/load.js';
import { startServer } from '../opencode/server.js';
import { ConsoleReporter } from '../report/console.js';
import { ExitCode } from '../exit.js';
import { scaffold, type ScaffoldResult } from './scaffold.js';
import { planState } from './plan.js';
import { DONE_COMMAND, type InterviewOutcome } from './interview.js';
import { TerminalIO } from './terminal.js';
import { terminalAskRelay } from './terminal-asks.js';
import { PlanRecorder, RecordingIO } from './record.js';
import { planningProblem, planWith } from './session.js';
import { ownerOf, runInProgress } from '../daemon/command.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

const BY_HAND =
  'Next: describe the project in .ralph/prd/PRD.md, fill in .ralph/tasks.json and its specs, then run `ralph doctor`.';

/**
 * `ralph init`: scaffold `.ralph/`, then, in a terminal, plan the project with
 * the configured agent. Config is loaded only after scaffolding, so the
 * scaffold never depends on it and the interview sees the new config file.
 */
export async function runInit(args: {
  projectRoot: string;
  interview: boolean;
  replan: boolean;
  load: () => { config: Config; logger: Logger };
}): Promise<number> {
  const out = process.stdout;
  const result = scaffold(args.projectRoot);
  if (result.status === 'legacy') {
    process.stderr.write(`${result.message}\n`);
    return ExitCode.ConfigError;
  }
  out.write(`${describeScaffold(result)}\n`);

  if (!args.interview) {
    out.write(`\n${BY_HAND}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !out.isTTY) {
    out.write(`\nNot a terminal, so no planning interview. Run \`ralph init\` in a terminal to plan with the agent.\n${BY_HAND}\n`);
    return 0;
  }

  const { config, logger } = args.load();
  const problem = planningProblem(config);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return ExitCode.ConfigError;
  }
  // One process at a time holds the project; a daemon plans from the web UI.
  const owner = ownerOf(config) ?? runInProgress(config);
  if (owner) {
    process.stderr.write(`Not planning: ${owner}\n`);
    return ExitCode.ConfigError;
  }

  const existing = planState(config.projectRoot, config.ralphDir) === 'written';
  if (existing && !args.replan) {
    out.write(`\nA plan already exists in ${RALPH_DIR}/. Run \`ralph init --replan\` to revise it with the agent.\n`);
    return 0;
  }

  const reporter = new ConsoleReporter(out);
  const controller = new AbortController();
  const server = await startServer(config.server, { cwd: config.projectRoot, logger });
  const terminal = new TerminalIO(out, process.stdin, () => controller.abort());
  // Recorded under history/plans/, so the web UI shows the interview too.
  const io = new RecordingIO(terminal, new PlanRecorder(resolve(config.projectRoot, config.ralphDir), { mode: existing ? 'replan' : 'new', by: 'cli' }));

  try {
    reporter.banner([
      `ralph init · ${existing ? 'revising the plan' : 'planning'} with ${config.plan.model ?? config.model ?? 'the server default model'}`,
      existing ? '  Say what should change; the agent will ask about the rest.' : '  Describe the project, then answer the agent\'s questions.',
      `  End a message with an empty line · ${DONE_COMMAND} to have it write the plan now · Ctrl-C to stop`,
    ]);
    const outcome = await planWith({
      client: server.client,
      config,
      logger,
      io,
      signal: controller.signal,
      replan: existing,
      asks: terminalAskRelay(io),
    });
    // Leave raw mode before printing the summary.
    terminal.close();
    return report(outcome, reporter);
  } finally {
    terminal.close();
    io.recorder.close();
    await server.stop();
  }
}

function describeScaffold(result: Extract<ScaffoldResult, { status: 'scaffolded' }>): string {
  return [
    ...result.created.map((path) => `  created  ${path}`),
    ...result.updated.map((path) => `  updated  ${path}`),
    ...result.skipped.map(
      (path) => `  skipped  ${path} (${path.startsWith('.git') ? 'already has its entries' : 'exists'})`,
    ),
  ].join('\n');
}

function report(outcome: InterviewOutcome, reporter: ConsoleReporter): number {
  if (outcome.outsideChanges === null) {
    reporter.summary('Not a git repository', [`Could not check for changes outside ${RALPH_DIR}/.`], 'warn');
  } else if (outcome.outsideChanges.length > 0) {
    reporter.summary(
      `⚠️  The agent changed files outside ${RALPH_DIR}/`,
      [...outcome.outsideChanges, '', 'Review them with `git status` and `git diff`.'],
      'warn',
    );
  }

  switch (outcome.status) {
    case 'planned':
      reporter.summary(
        `Plan written: ${outcome.tasks.length} task${outcome.tasks.length === 1 ? '' : 's'}`,
        [
          ...outcome.tasks.map((task) => `${task.id}  ${task.title}`),
          '',
          `Review ${RALPH_DIR}/ and commit it, then run \`ralph doctor\` and \`ralph\`.`,
        ],
        'good',
      );
      return ExitCode.Complete;
    case 'invalid':
      reporter.summary(
        'The plan still has problems',
        [...outcome.problems, '', 'Fix them by hand, or run `ralph init --replan`.'],
        'bad',
      );
      return ExitCode.ConfigError;
    case 'aborted':
      reporter.summary(
        '■ Stopped',
        [`Anything the agent wrote is in ${RALPH_DIR}/. Run \`ralph init --replan\` to continue.`],
        'warn',
      );
      return ExitCode.Interrupted;
    case 'failed':
      reporter.summary('Planning failed', [outcome.reason], 'bad');
      return {
        provider: ExitCode.ProviderError,
        server: ExitCode.ProviderError,
        blocked: ExitCode.Blocked,
        turns: ExitCode.MaxIterations,
      }[outcome.cause];
  }
}
