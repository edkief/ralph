import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';
import { startOpencode } from '../opencode/index.js';
import { startPi } from '../pi/index.js';
import type { AgentHarness } from './types.js';

/** A harness that was selected but did not come up; the message names it. Exit code 5. */
export class HarnessStartError extends Error {
  constructor(harness: string, cause: unknown) {
    super(`The ${harness} harness did not start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * Start the agent harness the config picks. This is the one module that knows
 * which adapters exist; everything else drives an `AgentHarness`.
 */
export async function startHarness(
  config: Config,
  options: { cwd: string; logger: Logger },
): Promise<AgentHarness> {
  switch (config.harness) {
    case 'opencode':
      try {
        return await startOpencode(config.server, options);
      } catch (cause) {
        throw new HarnessStartError('opencode', cause);
      }
    case 'pi':
      try {
        return await startPi(config, options);
      } catch (cause) {
        throw new HarnessStartError('pi', cause);
      }
  }
}
