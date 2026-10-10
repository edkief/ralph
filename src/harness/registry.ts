import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';
import { startOpencode } from '../opencode/index.js';
import type { AgentHarness } from './types.js';

/**
 * Start the agent harness the config picks. This is the one module that knows
 * which adapters exist; everything else drives an `AgentHarness`.
 */
export async function startHarness(
  config: Config,
  options: { cwd: string; logger: Logger },
): Promise<AgentHarness> {
  return startOpencode(config.server, options);
}
