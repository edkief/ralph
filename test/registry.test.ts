import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/load.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { HarnessStartError, startHarness } from '../src/harness/registry.js';
import { Logger } from '../src/report/logger.js';
import { startFakeServer, type FakeServer } from './helpers/fake-server.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WritableStream });

function config(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ projectRoot: process.cwd(), ...overrides });
}

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startHarness', () => {
  it('starts opencode, the default, against the server the config names', async () => {
    server = await startFakeServer({ script: [] });

    const harness = await startHarness(config({ server: { url: server.url } }), { cwd: process.cwd(), logger });

    expect(harness.name).toBe('opencode');
    await harness.stop();
  });

  it('says pi is not yet available, as a config error, until its adapter exists', async () => {
    const started = startHarness(config({ harness: 'pi' }), { cwd: process.cwd(), logger });

    await expect(started).rejects.toBeInstanceOf(ConfigError);
    await expect(started).rejects.toThrow(/pi harness is not yet available/);
  });

  it('names the harness in the error when it does not come up', async () => {
    const started = startHarness(config({ server: { url: 'http://127.0.0.1:1', startupTimeoutMs: 300 } }), {
      cwd: process.cwd(),
      logger,
    });

    await expect(started).rejects.toBeInstanceOf(HarnessStartError);
    await expect(started).rejects.toThrow(/^The opencode harness did not start: /);
  });
});
