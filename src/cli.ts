#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config/load.js';
import { startServer } from './opencode/server.js';
import { preflight } from './opencode/preflight.js';
import { runLoop } from './loop/orchestrator.js';
import { ConsoleReporter, formatDuration } from './report/console.js';
import { Logger } from './report/logger.js';
import { ExitCode } from './exit.js';
import type { Config } from './config/schema.js';

const HELP = `ralph — long-running agent loop for opencode

Usage:
  ralph [run] [options]     Run the loop until the backlog is done
  ralph once [options]      Run exactly one iteration
  ralph doctor [options]    Check the environment and exit
  ralph config [options]    Print the resolved configuration

Options:
  -n, --max-iterations <n>  Iteration budget (default 10)
  -m, --model <id>          provider/model, e.g. ollama/qwen3-coder
  -a, --agent <name>        opencode agent profile
  -C, --cwd <path>          Project root (default: current directory)
      --config <path>       Config file (default: <root>/ralph.config.json)
      --server <url>        Attach to an existing opencode server
      --no-pin-task         Let the agent choose its own task
      --log-format <fmt>    text | json
      --log-level <level>   debug | info | warn | error
  -h, --help                Show this help

Exit codes:
  0 complete · 1 budget exhausted · 2 blocked · 3 decision needed
  4 config/preflight · 5 provider · 6 stalled · 130 interrupted
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'max-iterations': { type: 'string', short: 'n' },
      model: { type: 'string', short: 'm' },
      agent: { type: 'string', short: 'a' },
      cwd: { type: 'string', short: 'C' },
      config: { type: 'string' },
      server: { type: 'string' },
      'pin-task': { type: 'boolean', default: true },
      'log-format': { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = positionals[0] ?? 'run';
  if (!['run', 'once', 'doctor', 'config'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return ExitCode.ConfigError;
  }

  const overrides: Record<string, unknown> = {
    ...(values['max-iterations'] ? { maxIterations: Number(values['max-iterations']) } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.agent ? { agent: values.agent } : {}),
    ...(values['pin-task'] === false ? { pinTask: false } : {}),
    ...(command === 'once' ? { maxIterations: 1 } : {}),
    ...(values.server ? { server: { url: values.server } } : {}),
    log: {
      ...(values['log-format'] ? { format: values['log-format'] } : {}),
      ...(values['log-level'] ? { level: values['log-level'] } : {}),
    },
  };

  const config = loadConfig({
    projectRoot: values.cwd ?? process.cwd(),
    overrides,
    ...(values.config ? { configPath: values.config } : {}),
  });

  if (command === 'config') {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  return runCommand(command, config);
}

async function runCommand(command: string, config: Config): Promise<number> {
  const logger = new Logger({ level: config.log.level, format: config.log.format });
  const reporter = new ConsoleReporter();
  const controller = new AbortController();

  const onSignal = () => {
    logger.warn('signal received, finishing current iteration');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const server = await startServer(config.server, { cwd: config.projectRoot, logger });

  try {
    const checks = await preflight(config, server.client);
    reporter.banner([
      'ralph · opencode loop',
      ...checks.map((check) => `  ${check.ok ? '✓' : check.fatal ? '✗' : '!'} ${check.name}: ${check.detail}`),
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

    const startedAt = Date.now();
    const result = await runLoop({
      config,
      client: server.client,
      logger,
      reporter,
      signal: controller.signal,
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
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await server.stop();
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
