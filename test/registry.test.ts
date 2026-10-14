import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { HarnessStartError, startHarness } from '../src/harness/registry.js';
import { Logger } from '../src/report/logger.js';
import { startFakeServer, type FakeServer } from './helpers/fake-server.js';
import { fakePi } from './helpers/pi.js';

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
  it('starts opencode when the config picks it, against the server the config names', async () => {
    server = await startFakeServer({ script: [] });

    const harness = await startHarness(config({ harness: 'opencode', server: { url: server.url } }), { cwd: process.cwd(), logger });

    expect(harness.name).toBe('opencode');
    await harness.stop();
  });

  it('starts pi, the default, when the config names no harness', async () => {
    const harness = await startHarness(config({ pi: { binary: fakePi().binary } }), { cwd: process.cwd(), logger });

    expect(harness.name).toBe('pi');
    await harness.stop();
  });

  it('starts pi when the config picks it, once its executable runs', async () => {
    const harness = await startHarness(config({ harness: 'pi', pi: { binary: fakePi().binary } }), { cwd: process.cwd(), logger });

    expect(harness.name).toBe('pi');
    await harness.stop();
  });

  it('names pi in the error when its executable does not run', async () => {
    const started = startHarness(config({ harness: 'pi', pi: { binary: '/nonexistent/pi' } }), { cwd: process.cwd(), logger });

    await expect(started).rejects.toBeInstanceOf(HarnessStartError);
    await expect(started).rejects.toThrow(/^The pi harness did not start: Could not run `\/nonexistent\/pi --version`: .*not installed/);
  });

  it('names the harness in the error when it does not come up', async () => {
    const started = startHarness(config({ harness: 'opencode', server: { url: 'http://127.0.0.1:1', startupTimeoutMs: 300 } }), {
      cwd: process.cwd(),
      logger,
    });

    await expect(started).rejects.toBeInstanceOf(HarnessStartError);
    await expect(started).rejects.toThrow(/^The opencode harness did not start: /);
  });
});
