import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { Logger } from '../report/logger.js';

const run = promisify(execFile);

const CLOSE_TIMEOUT_MS = 15_000;

/**
 * A playwright-cli session name for one pi process. playwright-cli reads it from `PLAYWRIGHT_CLI_SESSION`,
 * which the agent's shell inherits from pi, so the browser the agent opens is this process's alone.
 */
export function browserSessionName(): string {
  return `ralph-${randomBytes(4).toString('hex')}`;
}

/**
 * Close the browser a pi process may have left open. Never throws: no playwright-cli, a browser that is not
 * open and a command that hangs are all the same here, a cleanup that was not needed or not possible.
 */
export async function closeBrowserSession(cli: string, session: string, logger: Logger): Promise<void> {
  try {
    await run(cli, [`-s=${session}`, 'close'], { timeout: CLOSE_TIMEOUT_MS });
    logger.debug('closed the browser of a pi process', { session });
  } catch (cause) {
    logger.debug('could not close the browser of a pi process', { session, error: (cause as Error).message });
  }
}
