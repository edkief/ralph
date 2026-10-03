import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { startServer, sleep } from '../opencode/server.js';
import { preflight } from '../opencode/preflight.js';
import { runLoop } from '../loop/orchestrator.js';
import { requestStop, STOP_MESSAGES } from '../human/request.js';
import { startUiBesideLoop } from '../ui/command.js';
import { RalphProject } from '../ui/project.js';
import { ConsoleReporter } from '../report/console.js';
import { ExitCode } from '../exit.js';
import {
  daemonLive,
  daemonLogPath,
  DaemonRequestError,
  liveDaemon,
  readDaemonState,
  requestRun,
  requestShutdown,
  type DaemonState,
} from './control.js';
import { daemonLoop, markStopped, type BatchOutcome } from './daemon.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

const ralphRootOf = (config: Config) => resolve(config.projectRoot, config.ralphDir);

/** Why another loop may not start here, if one already owns the project. */
export function ownerOf(config: Config): string | undefined {
  const daemon = liveDaemon(ralphRootOf(config));
  if (daemon) return `a daemon (pid ${daemon.pid}) runs this project: steer it with \`ralph daemon run\` and \`ralph daemon pause\``;
  return undefined;
}

/**
 * `ralph daemon`: hold the opencode server and the web UI, and run a batch of
 * iterations whenever asked, until shut down. Each batch is a run of the loop
 * with a fresh budget and the configuration as it is then; however it ends,
 * the daemon goes back to idle.
 */
export async function runDaemon(args: {
  config: Config;
  logger: Logger;
  /** The configuration as it stands now, read again for each batch. */
  reload: () => Config;
  /** Run a first batch at once. */
  start: boolean;
  /** Serve the web UI; on unless turned off. */
  ui: boolean;
}): Promise<number> {
  const { config, logger } = args;
  const ralphRoot = ralphRootOf(config);
  const owner = ownerOf(config) ?? runInProgress(config);
  if (owner) {
    process.stderr.write(`Not starting a daemon: ${owner}\n`);
    return ExitCode.ConfigError;
  }

  const shutdown = new AbortController();
  const onSignal = () => {
    if (shutdown.signal.aborted) return;
    logger.warn('shutting down the daemon');
    shutdown.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  const ui = args.ui ? await startUiBesideLoop(config, logger) : undefined;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(config.server, { cwd: config.projectRoot, logger });
  } catch (cause) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    await ui?.close();
    throw cause;
  }

  const runBatch = async (iterations: number, interrupt: AbortSignal): Promise<BatchOutcome> => {
    const fresh = args.reload();
    // Someone is around to answer: wait for them rather than end the batch.
    const batch: Config = { ...fresh, maxIterations: iterations, ui: { ...fresh.ui, wait: fresh.ui.wait ?? true } };
    const checks = await preflight(batch, server.client);
    for (const check of checks.filter((check) => !check.ok)) {
      logger[check.fatal ? 'error' : 'warn'](`preflight: ${check.name}`, { detail: check.detail });
    }
    const blocking = checks.filter((check) => !check.ok && check.fatal);
    if (blocking.length > 0) {
      return { status: 'failed', message: `Preflight failed: ${blocking.map((check) => `${check.name}: ${check.detail}`).join('; ')}` };
    }
    const result = await runLoop({
      config: batch,
      client: server.client,
      logger,
      reporter: new ConsoleReporter(),
      signal: interrupt,
      askForMore: false,
    });
    logger.info('batch ended', {
      status: result.status,
      iterations: result.iterations,
      tasks: `${result.tasksPassed}/${result.tasksTotal}`,
      message: result.message,
    });
    return { status: result.status, message: result.message };
  };

  try {
    await daemonLoop({
      ralphRoot,
      logger,
      signal: shutdown.signal,
      runBatch,
      defaultIterations: config.maxIterations,
      ...(args.start ? { start: config.maxIterations } : {}),
      ...(ui ? { uiUrl: ui.url } : {}),
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    await server.stop();
    await ui?.close();
    markStopped(ralphRoot);
  }
  logger.info('daemon stopped');
  return 0;
}

/** A loop already running here outside any daemon, as the web UI sees it. */
function runInProgress(config: Config): string | undefined {
  const run = new RalphProject(config.projectRoot, config.ralphDir).status().run;
  return run?.live ? `run ${run.runId} is in progress here; stop it first` : undefined;
}

/**
 * `ralph daemon --detach`: start the daemon as a process of its own, with its
 * output in `history/daemon.log`, and return once it is up.
 */
export async function detachDaemon(config: Config, argv: string[], timeoutMs = 60_000): Promise<number> {
  const ralphRoot = ralphRootOf(config);
  const owner = ownerOf(config) ?? runInProgress(config);
  if (owner) {
    process.stderr.write(`Not starting a daemon: ${owner}\n`);
    return ExitCode.ConfigError;
  }
  const logPath = daemonLogPath(ralphRoot);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1]!, ...argv.filter((arg) => arg !== '--detach')],
    { detached: true, stdio: ['ignore', fd, fd], cwd: process.cwd(), env: process.env },
  );
  closeSync(fd);
  let exited: number | null | undefined;
  child.once('exit', (code) => {
    exited = code;
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readDaemonState(ralphRoot);
    if (state && state.pid === child.pid && daemonLive(state)) {
      child.unref();
      process.stdout.write(
        [
          `ralph daemon started for ${config.projectRoot}`,
          `  pid ${state.pid}, ${state.status}`,
          ...(state.uiUrl ? [`  web UI ${state.uiUrl}`] : []),
          `  log ${logPath}`,
          '',
          'Steer it with `ralph daemon run -n <n>`, `ralph daemon pause`, `ralph daemon status`, `ralph daemon shutdown`.',
          '',
        ].join('\n'),
      );
      return 0;
    }
    if (exited !== undefined) {
      process.stderr.write(`The daemon exited (code ${exited}) before it was up. The end of ${logPath}:\n\n${tail(logPath)}\n`);
      return ExitCode.ConfigError;
    }
    if (Date.now() > deadline) {
      child.unref();
      process.stderr.write(`The daemon (pid ${child.pid}) is not up yet; follow ${logPath}\n`);
      return ExitCode.ConfigError;
    }
    await sleep(200);
  }
}

function tail(path: string, lines = 20): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no output)';
  }
}

/** `ralph daemon run|pause|status|shutdown`: steer the project's daemon from anywhere that shares the folder. */
export async function controlDaemon(args: {
  config: Config;
  action: string;
  iterations?: number;
  now: boolean;
  /** With `pause`: park the run rather than just stop it. */
  park?: boolean;
  /** How long `shutdown` waits for the daemon to be gone. */
  waitMs?: number;
}): Promise<number> {
  const { config } = args;
  const ralphRoot = ralphRootOf(config);
  try {
    switch (args.action) {
      case 'run': {
        const state = requestRun(ralphRoot, args.iterations, 'cli');
        process.stdout.write(`Asked the daemon (pid ${state.pid}) to run ${args.iterations ?? state.defaultIterations} iterations.\n`);
        return 0;
      }
      case 'pause': {
        const run = new RalphProject(config.projectRoot, config.ralphDir).status().run;
        if (!run?.live) {
          process.stderr.write('Nothing is running to pause.\n');
          return ExitCode.ConfigError;
        }
        const mode = args.park ? 'park' : args.now ? 'now' : 'after-iteration';
        requestStop(ralphRoot, mode, 'cli');
        process.stdout.write(`${STOP_MESSAGES[mode]}\n`);
        return 0;
      }
      case 'status':
        process.stdout.write(describe(config, readDaemonState(ralphRoot)));
        return 0;
      case 'shutdown': {
        const state = requestShutdown(ralphRoot, 'cli');
        process.stdout.write(`Asked the daemon (pid ${state.pid}) to shut down`);
        const deadline = Date.now() + (args.waitMs ?? config.server.shutdownTimeoutMs + 30_000);
        while (liveDaemon(ralphRoot) && Date.now() < deadline) await sleep(250);
        const gone = !liveDaemon(ralphRoot);
        process.stdout.write(gone ? '; it has stopped.\n' : '; it is still stopping.\n');
        return 0;
      }
      default:
        process.stderr.write(`Unknown daemon action: ${args.action}; use run, pause, status or shutdown\n`);
        return ExitCode.ConfigError;
    }
  } catch (cause) {
    if (!(cause instanceof DaemonRequestError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return ExitCode.ConfigError;
  }
}

function describe(config: Config, state: DaemonState | undefined): string {
  const run = new RalphProject(config.projectRoot, config.ralphDir).status().run;
  const lines = [];
  if (!state || !daemonLive(state)) {
    lines.push('No daemon is running for this project.');
  } else {
    lines.push(`Daemon pid ${state.pid} on ${state.hostname}, up since ${state.startedAt}: ${state.status}`);
    if (state.batch) lines.push(`  batch of ${state.batch.iterations} iterations since ${state.batch.startedAt}`);
    lines.push(`  default batch: ${state.defaultIterations} iterations`);
    if (state.uiUrl) lines.push(`  web UI ${state.uiUrl}`);
    if (state.lastBatch && !state.batch) lines.push(`  last batch: ${state.lastBatch.status} — ${state.lastBatch.message}`);
  }
  if (run) {
    lines.push(
      `Latest run ${run.runId}: ${run.status}${run.live ? `, iteration ${run.iteration}/${run.maxIterations ?? '?'}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
