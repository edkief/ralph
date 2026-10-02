#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config/load.js';
import { startServer } from './opencode/server.js';
import { preflight } from './opencode/preflight.js';
import { runLoop } from './loop/orchestrator.js';
import { runInit } from './init/command.js';
import { runUi, startUiBesideLoop } from './ui/command.js';
import { runSplit } from './split/command.js';
import { runRespond } from './human/command.js';
import { pendingState, respond } from './human/respond.js';
import { ConsoleReporter, formatDuration } from './report/console.js';
import { Logger } from './report/logger.js';
import { startMenu } from './report/menu.js';
import { formatTimestamp } from './report/time.js';
import { ExitCode } from './exit.js';
import type { Config } from './config/schema.js';

const HELP = `ralph — long-running agent loop for opencode

Usage:
  ralph [run] [options]     Run the loop until the backlog is done
  ralph once [options]      Run exactly one iteration
  ralph doctor [options]    Check the environment and exit
  ralph config [options]    Print the resolved configuration
  ralph init [options]      Scaffold .ralph/, then plan the project with the agent
  ralph ui [options]        Serve the web UI to watch runs and browse .ralph/
  ralph split <task> [--apply]
                            Propose splitting a task into smaller ones, or apply the proposal
  ralph respond [action] [text]
                            Show what Ralph is asking a person, or answer it

Init options:
      --no-interview        Only scaffold; also the default outside a terminal
      --replan              Revise an existing plan with the agent
  -m, --model <id>          Model for the planning interview (default: plan.model, then model)

Split options:
      --apply               Replace the task with the proposed ones and commit
  -m, --model <id>          Model for the proposal (default: plan.model, then model)

Respond options:
      --iterations <n>      Iterations to add, for \`ralph respond continue\`

Options:
  -n, --max-iterations <n>  Iteration budget (default 10)
  -m, --model <id>          provider/model, e.g. ollama/qwen3-coder
  -a, --agent <name>        opencode agent profile
  -C, --cwd <path>          Project root (default: current directory)
      --ralph-dir <path>    Ralph's project folder (default: .ralph)
      --config <path>       Config file (default: <root>/ralph.config.json)
      --server <url>        Attach to an existing opencode server
      --no-pin-task         Let the agent choose its own task
      --log-format <fmt>    text | json
      --log-level <level>   debug | info | warn | error
      --ui                  Also serve the web UI while the loop runs
      --ui-host <host>      Web UI address (default 127.0.0.1)
      --ui-port <port>      Web UI port (default 4280)
      --ui-base-path <path> Path prefix a reverse proxy serves the web UI under
      --wait, --no-wait     Wait for a person's answer instead of exiting when one is
                            needed (default: on with --ui)
  -h, --help                Show this help
  -v, --version             Print the version

Exit codes:
  0 complete · 1 budget exhausted · 2 blocked · 3 decision needed
  4 config/preflight · 5 provider · 6 stalled · 130 interrupted or stopped

Stopping:
  At a terminal, Enter opens a menu to stop after the current iteration or
  now, and to answer what Ralph asks. Ctrl-C stops now.
  Unattended, send SIGINT to stop after the current iteration, SIGTERM to stop now.
`;

/** From package.json, one level up from both src/cli.ts and dist/cli.js. */
function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    // Boolean options default on and are turned off with --no-<name>.
    allowNegative: true,
    options: {
      'max-iterations': { type: 'string', short: 'n' },
      model: { type: 'string', short: 'm' },
      agent: { type: 'string', short: 'a' },
      cwd: { type: 'string', short: 'C' },
      'ralph-dir': { type: 'string' },
      config: { type: 'string' },
      server: { type: 'string' },
      'pin-task': { type: 'boolean', default: true },
      'log-format': { type: 'string' },
      'log-level': { type: 'string' },
      ui: { type: 'boolean' },
      'ui-host': { type: 'string' },
      'ui-port': { type: 'string' },
      'ui-base-path': { type: 'string' },
      wait: { type: 'boolean' },
      interview: { type: 'boolean', default: true },
      replan: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      iterations: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const command = positionals[0] ?? 'run';
  if (!['run', 'once', 'doctor', 'config', 'init', 'ui', 'split', 'respond'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return ExitCode.ConfigError;
  }

  const overrides: Record<string, unknown> = {
    ...(values['max-iterations'] ? { maxIterations: Number(values['max-iterations']) } : {}),
    // For init and split, -m picks the planning model rather than the loop's.
    ...(values.model
      ? command === 'init' || command === 'split'
        ? { plan: { model: values.model } }
        : { model: values.model }
      : {}),
    ...(values.agent ? { agent: values.agent } : {}),
    ...(values['ralph-dir'] ? { ralphDir: values['ralph-dir'] } : {}),
    ...(values['pin-task'] === false ? { pinTask: false } : {}),
    ...(command === 'once' ? { maxIterations: 1 } : {}),
    ...(values.server ? { server: { url: values.server } } : {}),
    ui: {
      ...(values.ui !== undefined ? { enabled: values.ui } : {}),
      ...(values['ui-host'] ? { host: values['ui-host'] } : {}),
      ...(values['ui-port'] ? { port: Number(values['ui-port']) } : {}),
      ...(values['ui-base-path'] ? { basePath: values['ui-base-path'] } : {}),
      ...(values.wait !== undefined ? { wait: values.wait } : {}),
    },
    log: {
      ...(values['log-format'] ? { format: values['log-format'] } : {}),
      // Info logs would interleave with the planning conversation.
      ...(values['log-level'] ? { level: values['log-level'] } : command === 'init' ? { level: 'warn' } : {}),
    },
  };

  const load = () => {
    // The logger's format comes from the config, so hold warnings until it exists.
    const warnings: string[] = [];
    const config = loadConfig({
      projectRoot: values.cwd ?? process.cwd(),
      overrides,
      onWarning: (message) => warnings.push(message),
      ...(values.config ? { configPath: values.config } : {}),
    });
    const logger = new Logger({ level: config.log.level, format: config.log.format });
    for (const warning of warnings) logger.warn(warning);
    return { config, logger };
  };

  // Scaffolding needs no config, server or preflight; only the interview loads them.
  if (command === 'init') {
    return runInit({
      projectRoot: values.cwd ?? process.cwd(),
      interview: values.interview !== false,
      replan: values.replan === true,
      load,
    });
  }

  const { config, logger } = load();

  if (command === 'config') {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  if (command === 'ui') return runUi(config, logger);
  if (command === 'split') return runSplit({ config, logger, taskId: positionals[1], apply: values.apply === true });

  if (command === 'respond') {
    const iterations = values.iterations ? Number(values.iterations) : undefined;
    if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1)) {
      process.stderr.write('--iterations must be a positive whole number\n');
      return ExitCode.ConfigError;
    }
    return runRespond({
      config,
      action: positionals[1],
      text: positionals.slice(2).join(' '),
      ...(iterations !== undefined ? { iterations } : {}),
    });
  }

  return runCommand(command, config, logger);
}

async function runCommand(command: string, config: Config, logger: Logger): Promise<number> {
  const reporter = new ConsoleReporter();
  // `stop` lets the current iteration finish; `controller` interrupts it.
  const stop = new AbortController();
  const controller = new AbortController();
  // Both write to the terminal: keep log lines off the end of the status line.
  logger.beforeWrite(() => reporter.clearStatus());

  const onTerminate = () => {
    if (controller.signal.aborted) return;
    logger.warn('stopping now, interrupting the current iteration');
    controller.abort();
  };
  // A Ctrl-C at a terminal reaches the opencode server as well, which ends
  // its work there and then: nothing is left to finish. A SIGINT sent to
  // Ralph alone asks to stop after the current iteration; a second one stops now.
  const onInterrupt = () => {
    if (process.stdin.isTTY || stop.signal.aborted) return onTerminate();
    logger.warn('stopping after the current iteration; send SIGINT again or SIGTERM to stop now');
    stop.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onTerminate);
  // With a terminal on both ends, the run is steered from a menu there.
  const interactive = command !== 'doctor' && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let closeMenu: (() => void) | undefined;

  // Up before the opencode server, so preflight problems are visible in it too.
  const ui = config.ui.enabled && command !== 'doctor' ? await startUiBesideLoop(config, logger) : undefined;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(config.server, { cwd: config.projectRoot, logger });
  } catch (cause) {
    await ui?.close();
    throw cause;
  }

  try {
    const checks = await preflight(config, server.client);
    reporter.banner([
      'ralph · opencode loop',
      `  started ${formatTimestamp(new Date())}`,
      ...checks.map((check) => `  ${check.ok ? '✓' : check.fatal ? '✗' : '!'} ${check.name}: ${check.detail}`),
      ...(interactive ? ['  Enter for a menu: stop, or answer what Ralph asks · Ctrl-C to stop now'] : []),
    ]);

    const blocking = checks.filter((check) => !check.ok && check.fatal);
    if (blocking.length > 0) {
      reporter.summary(
        'Preflight failed',
        blocking.map((check) => `${check.name}: ${check.detail}`),
        'bad',
      );
      return ExitCode.ConfigError;
    }
    if (command === 'doctor') {
      reporter.summary('Environment looks runnable', [], 'good');
      return 0;
    }

    if (interactive) {
      closeMenu = startMenu({
        input: process.stdin,
        output: process.stdout,
        hold: () => {
          reporter.hold();
          logger.hold();
        },
        release: () => {
          reporter.release();
          logger.release();
        },
        stopAfterIteration: () => {
          if (stop.signal.aborted) return;
          logger.warn('stopping after the current iteration');
          stop.abort();
        },
        stopNow: () => {
          // Asked twice: the stop itself is stuck. The exit hook takes the server along.
          if (controller.signal.aborted) {
            closeMenu?.();
            process.exit(ExitCode.Interrupted);
          }
          onTerminate();
        },
        pending: () => pendingState(config.projectRoot, config.ralphDir),
        answer: async (input) =>
          (await respond({ projectRoot: config.projectRoot, ralphDir: config.ralphDir, input, by: 'cli' })).message,
      });
      // Whatever ends the process, the terminal must not be left in raw mode.
      process.once('exit', closeMenu);
    }

    const startedAt = Date.now();
    const result = await runLoop({
      config,
      client: server.client,
      logger,
      reporter,
      signal: controller.signal,
      stop: stop.signal,
    });

    reporter.summary(
      summaryTitle(result.status),
      [
        result.message,
        `Tasks: ${result.tasksPassed}/${result.tasksTotal} passing`,
        `Iterations: ${result.iterations} · Total: ${formatDuration(Date.now() - startedAt)}`,
        `History: ${result.historyDir}`,
      ],
      summaryTone(result.status),
    );

    return exitCodeFor(result.status);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('SIGHUP', onTerminate);
    closeMenu?.();
    logger.beforeWrite(undefined);
    await server.stop();
    await ui?.close();
  }
}

function summaryTitle(status: string): string {
  switch (status) {
    case 'complete':
      return '🎉 Ralph completed the backlog';
    case 'blocked':
      return '⛔ Blocked — needs a human';
    case 'decide':
      return '❓ Decision needed';
    case 'stalled':
      return '⚠️  Stalled — no progress';
    case 'interrupted':
      return '■ Interrupted';
    case 'stopped':
      return '■ Stopped on request';
    default:
      return '⚠️  Ralph stopped';
  }
}

function summaryTone(status: string): 'good' | 'warn' | 'bad' {
  if (status === 'complete') return 'good';
  if (status === 'blocked' || status === 'stalled' || status === 'provider-error') return 'bad';
  return 'warn';
}

function exitCodeFor(status: string): number {
  switch (status) {
    case 'complete':
      return ExitCode.Complete;
    case 'blocked':
      return ExitCode.Blocked;
    case 'decide':
      return ExitCode.Decide;
    case 'provider-error':
      return ExitCode.ProviderError;
    case 'stalled':
      return ExitCode.Stalled;
    case 'interrupted':
    case 'stopped':
      return ExitCode.Interrupted;
    default:
      return ExitCode.MaxIterations;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`\n${message}\n`);
    process.exitCode = cause instanceof ConfigError ? ExitCode.ConfigError : ExitCode.ProviderError;
  });
