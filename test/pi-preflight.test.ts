import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { PiHarness } from '../src/pi/harness.js';
import { PI_VERSION_RANGE_TEXT, inVersionRange, parseVersion, piChecks, piVersion } from '../src/pi/preflight.js';
import { fakePi, type FakePiOptions } from './helpers/pi.js';
import { quietLogger } from './helpers/pi-harness.js';

async function check(fake: FakePiOptions = {}, overrides: Record<string, unknown> = {}, binary?: string) {
  const pi = fakePi(fake);
  const { pi: piOverrides, ...rest } = overrides as { pi?: Record<string, unknown> };
  const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', ...rest, pi: { ...piOverrides, binary: binary ?? pi.binary } });
  return Object.fromEntries((await piChecks(config, { cwd: process.cwd(), logger: quietLogger })).map((result) => [result.name, result]));
}

describe('piVersion', () => {
  it('reads the version from stderr, where pi writes it', async () => {
    expect(await piVersion(fakePi({ version: '0.73.1' }).binary)).toBe('0.73.1');
  });
});

describe('pi version range', () => {
  it('takes the tested release and its patch releases, and nothing newer or older', () => {
    const inRange = (text: string) => inVersionRange(parseVersion(text)!);
    expect(PI_VERSION_RANGE_TEXT).toBe('>=0.73.1 <0.74.0');
    expect(inRange('0.73.1')).toBe(true);
    expect(inRange('0.73.9')).toBe(true);
    expect(inRange('0.73.0')).toBe(false);
    expect(inRange('0.72.9')).toBe(false);
    expect(inRange('0.74.0')).toBe(false);
    expect(inRange('1.0.0')).toBe(false);
  });

  it('finds the version in what `pi --version` prints', () => {
    expect(parseVersion('0.73.1\n')).toEqual([0, 73, 1]);
    expect(parseVersion('pi v0.73.1 (abc)')).toEqual([0, 73, 1]);
    expect(parseVersion('no version')).toBeUndefined();
  });
});

describe('piChecks', () => {
  it('passes a pi in the range that has the model asked for', async () => {
    const checks = await check({ models: [{ provider: 'local', id: 'qwen' }], skills: ['demo'] }, { model: 'local/qwen' });
    expect(checks['pi']).toMatchObject({ ok: true, fatal: true, detail: expect.stringContaining('0.73.1') });
    expect(checks['model']).toMatchObject({ ok: true, detail: 'local/qwen' });
    expect(checks['skills']).toMatchObject({ ok: true, detail: '1 available (demo)' });
  });

  it.each(['0.72.0', '0.74.0', '1.2.3'])('rejects pi %s, outside the range, as fatal, and probes nothing else', async (version) => {
    const checks = await check({ version });
    expect(checks['pi']).toMatchObject({ ok: false, fatal: true });
    expect(checks['pi']?.detail).toContain(`${version} is outside`);
    expect(checks['pi']?.detail).toContain(PI_VERSION_RANGE_TEXT);
    expect(Object.keys(checks)).toEqual(['pi']);
  });

  it('says pi is not installed when the executable is missing', async () => {
    const checks = await check({}, {}, '/nonexistent/pi');
    expect(checks['pi']).toMatchObject({ ok: false, fatal: true, detail: expect.stringContaining('not installed') });
  });

  it('rejects a model pi does not have, naming the ones it has and where to define it', async () => {
    const checks = await check({ models: [{ provider: 'local', id: 'qwen' }] }, { model: 'local/nope' });
    expect(checks['model']).toMatchObject({ ok: false, fatal: true });
    expect(checks['model']?.detail).toContain('pi has no model local/nope');
    expect(checks['model']?.detail).toContain('models.json');
    expect(checks['model']?.detail).toContain('local/qwen');
  });

  it('checks the planning and escalation models too, each under its own name', async () => {
    const checks = await check(
      { models: [{ provider: 'local', id: 'qwen' }] },
      { model: 'local/qwen', plan: { model: 'local/big' }, escalation: { model: 'local/qwen' } },
    );
    expect(checks['model']).toMatchObject({ ok: true });
    expect(checks['plan model']).toMatchObject({ ok: false, fatal: true });
    expect(checks['escalation model']).toMatchObject({ ok: true });
  });

  it('without a model set, says which one pi would use, and fails when it would use none', async () => {
    const withNone = await check({}, {});
    // The fake, like pi, starts on the model it is told with --model, and has none otherwise.
    expect(withNone['model']).toMatchObject({ ok: false, fatal: true, detail: expect.stringContaining('no default model') });
    const configured = await check({ models: [{ provider: 'stub', id: 'stub-model' }] }, { pi: { args: ['--model', 'stub/stub-model'] } });
    expect(configured['model']).toMatchObject({ ok: true, fatal: false, detail: expect.stringContaining('stub/stub-model') });
  });

  it('warns that skills are missing when there are none, without failing', async () => {
    const checks = await check({ skills: [] }, { model: 'stub/stub-model' });
    expect(checks['skills']).toMatchObject({ ok: false, fatal: false, detail: expect.stringContaining('without skills') });
  });

  it('always warns that the permissions rules are not enforced, without stopping the run', async () => {
    const checks = await check({}, { model: 'stub/stub-model' });
    expect(checks['permissions']).toMatchObject({ ok: false, fatal: false });
    expect(checks['permissions']?.detail).toMatch(/not enforced under pi/);
    expect(checks['permissions']?.detail).toContain('git push');
  });

  it('stops the probe process it started', async () => {
    const pi = fakePi();
    const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', model: 'stub/stub-model', pi: { binary: pi.binary } });
    await piChecks(config, { cwd: process.cwd(), logger: quietLogger });
    const [probe] = pi.processes();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(probe!.pid, 0)).toThrow();
    // The probe keeps no session file.
    expect(pi.starts()[0]).toContain('--no-session');
  });

  it('is what the harness reports from its preflight', async () => {
    const pi = fakePi();
    const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', model: 'stub/stub-model', pi: { binary: pi.binary } });
    const harness = new PiHarness(config, { cwd: process.cwd(), logger: quietLogger });
    const names = (await harness.preflight(config)).map((result) => result.name);
    expect(names).toEqual(['pi', 'model', 'skills', 'permissions']);
    await harness.stop();
  });
});
