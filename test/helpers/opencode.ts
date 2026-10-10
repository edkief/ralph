import { OpencodeClient } from '../../src/opencode/client.js';
import { OpencodeHarness } from '../../src/opencode/harness.js';

/** The opencode adapter over a (fake) server that is already up. */
export function opencodeHarness(baseUrl: string, password?: string): Promise<OpencodeHarness> {
  return OpencodeHarness.connect(new OpencodeClient({ baseUrl, ...(password ? { password } : {}) }));
}
