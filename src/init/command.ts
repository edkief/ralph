import { resolve } from 'node:path';
import { RALPH_DIR } from '../config/load.js';
import { startHarness } from '../harness/registry.js';
import { ConsoleReporter } from '../report/console.js';
import { ExitCode } from '../exit.js';
import { scaffold, type ScaffoldResult } from './scaffold.js';
import { planState } from './plan.js';
import { DONE_COMMAND } from './interview.js';
import { TerminalIO } from './terminal.js';
import { terminalAskRelay } from './terminal-asks.js';
import { PlanRecorder, RecordingIO } from './record.js';
import { planningProblem, planWith, type PlanOutcome } from './session.js';
import { ownerOf, runInProgress } from '../daemon/command.js';
import { detectPacks, isInstalled, resolvePacks, UnknownPackError, type Pack } from '../skills/packs.js';
import { installPacks, type CommandRunner } from '../skills/command.js';
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
  /** Skill packs to install after scaffolding (`--skills`). */
  skills?: string[];
  /** Runs the `skills` CLI; tests pass a fake. */
  runCommand?: CommandRunner;
  load: () => { config: Config; logger: Logger };
}): Promise<number> {
  const out = process.stdout;
  let packs: Pack[] = [];
  try {
    packs = resolvePacks(args.skills ?? []);
  } catch (cause) {
    if (!(cause instanceof UnknownPackError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return ExitCode.ConfigError;
  }
  const result = scaffold(args.projectRoot);
  if (result.status === 'legacy') {
    process.stderr.write(`${result.message}\n`);
    return ExitCode.ConfigError;
  }
  out.write(`${describeScaffold(result)}\n`);
  await addSkills(args.projectRoot, packs, args.runCommand);

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
  const harness = await startHarness(config, { cwd: config.projectRoot, logger });
  const terminal = new TerminalIO(out, process.stdin, () => controller.abort());
  // Recorded under history/plans/, so the web UI shows the interview too.
  const io = new RecordingIO(terminal, new PlanRecorder(resolve(config.projectRoot, config.ralphDir), { mode: existing ? 'replan' : 'new', by: 'cli', harness: harness.name }));

  try {
    reporter.banner([
      `ralph init · ${existing ? 'revising the plan' : 'planning'} with ${config.plan.model ?? config.model ?? 'the harness default model'}`,
      existing ? '  Say what should change; the agent will ask about the rest.' : '  Describe the project, then answer the agent\'s questions.',
      `  End a message with an empty line · ${DONE_COMMAND} to have it write the plan now · Ctrl-C to stop`,
    ]);
    const outcome = await planWith({
      harness,
      config,
      logger,
      io,
      signal: controller.signal,
      replan: existing,
      asks: terminalAskRelay(io),
      scaffolded: [...result.created, ...result.updated],
    });
    // Leave raw mode before printing the summary.
    terminal.close();
    return report(outcome, reporter);
  } finally {
    terminal.close();
    io.recorder.close();
    await harness.stop();
  }
}

/**
 * Install the packs asked for, or mention the ones the project suggests and
 * lacks. A failed install is reported and planning goes on: the scaffold
 * stands, and `ralph skills add` can try again.
 */
async function addSkills(projectRoot: string, packs: Pack[], run?: CommandRunner): Promise<void> {
  if (packs.length === 0) {
    const missing = detectPacks(projectRoot).filter((pack) => !isInstalled(projectRoot, pack)).map((pack) => pack.name);
    if (missing.length > 0) {
      process.stdout.write(
        `\nSkill packs this project suggests: ${missing.join(', ')}. Install with \`ralph skills add ${missing.join(' ')}\` (\`ralph skills\` lists them).\n`,
      );
    }
    return;
  }
  process.stdout.write(`\nInstalling skill packs: ${packs.map((pack) => pack.name).join(', ')}\n`);
  const installed = await installPacks(projectRoot, packs, run);
  process.stdout.write(`${installed.report.join('\n')}\n`);
  if (!installed.ok) {
    process.stdout.write('Some skill packs did not install; carrying on. Retry with `ralph skills add`.\n');
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

function report(outcome: PlanOutcome, reporter: ConsoleReporter): number {
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
          ...(outcome.commit?.committed
            ? [`Committed as \`${outcome.commit.subject}\`, with the conversation in its journal.`, 'Run `ralph doctor`, then `ralph`.']
            : [
                ...(outcome.commit?.error ? [`Could not commit the plan: ${outcome.commit.error}`] : []),
                `Review ${RALPH_DIR}/ and commit it, then run \`ralph doctor\` and \`ralph\`.`,
              ]),
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
