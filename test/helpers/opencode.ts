import type { HarnessEvent } from '../../src/harness/events.js';
import type { OpencodeFrame } from '../../src/opencode/frames.js';
import { OpencodeTranslator } from '../../src/opencode/translate.js';
import { OpencodeClient } from '../../src/opencode/client.js';
import { OpencodeHarness } from '../../src/opencode/harness.js';

/** The opencode adapter over a (fake) server that is already up. */
export function opencodeHarness(baseUrl: string, password?: string): Promise<OpencodeHarness> {
  return OpencodeHarness.connect(new OpencodeClient({ baseUrl, ...(password ? { password } : {}) }));
}

/** Frames as opencode sends them, as the adapter emits them. One stream: tool names carry across frames. */
export function translated(...frames: OpencodeFrame[]): HarnessEvent[] {
  const translator = new OpencodeTranslator();
  return frames.flatMap((frame) => translator.push(frame));
}
