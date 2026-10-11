import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from '../../src/config/schema.js';
import type { HarnessEvent } from '../../src/harness/events.js';
import { PiHarness, type PiHarnessOptions } from '../../src/pi/harness.js';
import { Logger } from '../../src/report/logger.js';
import { fakePi, type FakePi, type FakePiOptions } from './pi.js';

export const quietLogger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WritableStream });

export interface PiRig {
  harness: PiHarness;
  fake: FakePi;
  config: Config;
  projectRoot: string;
  /** Every event the harness has published since the rig was made. */
  events: HarnessEvent[];
  /** Resolves with the first event after `from` that `match` takes, or rejects after `timeoutMs`. */
  waitFor(match: (event: HarnessEvent) => boolean, timeoutMs?: number): Promise<HarnessEvent>;
  close(): Promise<void>;
}

/** A pi harness over a fake pi, in a project folder of its own, with its events collected. */
export async function piRig(
  fakeOptions: FakePiOptions = {},
  overrides: Record<string, unknown> = {},
  harnessOptions: Partial<PiHarnessOptions> = {},
): Promise<PiRig> {
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'ralph-pi-project-'));
  const fake = fakePi(fakeOptions);
  const { pi: piOverrides, ...rest } = overrides as { pi?: Record<string, unknown> };
  const config = ConfigSchema.parse({ projectRoot, ...rest, harness: 'pi', pi: { binary: fake.binary, ...piOverrides } });
  // Short waits, so a test does not sit through the real ones.
  const harness = new PiHarness(config, { cwd: projectRoot, logger: quietLogger, ...harnessOptions });

  const events: HarnessEvent[] = [];
  const controller = new AbortController();
  const stream = await harness.connectEvents(controller.signal);
  const watchers = new Set<() => void>();
  void (async () => {
    for await (const event of stream) {
      events.push(event);
      for (const watcher of watchers) watcher();
    }
  })();

  return {
    harness,
    fake,
    config,
    projectRoot,
    events,
    waitFor: (match, timeoutMs = 5_000) =>
      new Promise((resolveWait, reject) => {
        const check = () => {
          const found = events.find(match);
          if (!found) return false;
          watchers.delete(check);
          clearTimeout(timer);
          resolveWait(found);
          return true;
        };
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error(`no matching event within ${timeoutMs}ms; saw: ${events.map((event) => event.type).join(', ')}`));
        }, timeoutMs);
        if (!check()) watchers.add(check);
      }),
    async close() {
      controller.abort();
      await harness.stop();
    },
  };
}
