import { ExitCode } from '../exit.js';
import { isLoopback, startUiServer, type UiServer } from './server.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

/** Start the web UI for the configured project, warning when others can reach it. */
export async function startUi(config: Config, logger: Logger): Promise<UiServer> {
  const server = await startUiServer({
    projectRoot: config.projectRoot,
    ralphDir: config.ralphDir,
    host: config.ui.host,
    port: config.ui.port,
    basePath: config.ui.basePath,
    logger,
  });
  if (!isLoopback(config.ui.host)) {
    logger.warn('the web UI has no authentication and is reachable from other hosts; transcripts may contain secrets', {
      host: config.ui.host,
    });
  }
  return server;
}

/**
 * Start the web UI beside the loop. It is optional, so failing to start it
 * (e.g. its port is taken) is logged and the run goes on without it.
 */
export async function startUiBesideLoop(config: Config, logger: Logger): Promise<UiServer | undefined> {
  try {
    const server = await startUi(config, logger);
    logger.info('web UI', { url: server.url });
    return server;
  } catch (cause) {
    logger.warn('web UI not started', { error: (cause as Error).message });
    return undefined;
  }
}

/**
 * `ralph ui`: serve the web UI until interrupted. It reads everything from the
 * project's Ralph folder, so it can watch a loop running in another process
 * or browse the history of past runs.
 */
export async function runUi(config: Config, logger: Logger): Promise<number> {
  let server: UiServer;
  try {
    server = await startUi(config, logger);
  } catch (cause) {
    process.stderr.write(`Could not start the web UI on ${config.ui.host}:${config.ui.port}: ${(cause as Error).message}\n`);
    return ExitCode.ConfigError;
  }

  process.stdout.write(`\nralph web UI for ${config.projectRoot}\n  ${server.url}\n\nCtrl-C to stop.\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await server.close();
  return 0;
}
