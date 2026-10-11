import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';
import { PiHarness, piVersion } from './harness.js';

/**
 * Start the pi harness: check that the `pi` executable runs. Its processes are started per session, so
 * nothing else is up until the first session opens.
 */
export async function startPi(config: Config, options: { cwd: string; logger: Logger }): Promise<PiHarness> {
  let version: string;
  try {
    version = await piVersion(config.pi.binary);
  } catch (cause) {
    const reason = (cause as NodeJS.ErrnoException).code === 'ENOENT' ? `\`${config.pi.binary}\` is not installed or not on the PATH` : (cause as Error).message;
    throw new Error(`Could not run \`${config.pi.binary} --version\`: ${reason}`);
  }
  options.logger.info('using pi', { binary: config.pi.binary, version });
  return new PiHarness(config, options);
}
