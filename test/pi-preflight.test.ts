import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { GATE_EXTENSION } from '../src/pi/gate.js';
import { preflight } from '../src/loop/preflight.js';
import { PiHarness } from '../src/pi/harness.js';
import { BROWSER_SKILL, PI_PACKAGE, PI_VERSION_RANGE_TEXT, extensionsCheck, inVersionRange, parseVersion, piChecks, piVersion } from '../src/pi/preflight.js';
import { fakePi, type FakePiOptions } from './helpers/pi.js';
import { quietLogger } from './helpers/pi-harness.js';

/** A stand-in for playwright-cli that prints a version and the browsers it lists. */
function fakeBrowserCli(listing = '  Browsers:\n    /opt/ms-playwright/chromium-1243\n'): string {
  const path = resolve(mkdtempSync(resolve(tmpdir(), 'fake-playwright-cli-')), 'playwright-cli');
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.22; exit 0; fi\nif [ "$1" = "install-browser" ]; then printf '%s' '${listing}'; exit 0; fi\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

async function check(fake: FakePiOptions = {}, overrides: Record<string, unknown> = {}, binary?: string, options: { browserCli?: string } = {}) {
  const pi = fakePi(fake);
  const { pi: piOverrides, ...rest } = overrides as { pi?: Record<string, unknown> };
  const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', ...rest, pi: { ...piOverrides, binary: binary ?? pi.binary } });
  return Object.fromEntries((await piChecks(config, { cwd: process.cwd(), logger: quietLogger, ...options })).map((result) => [result.name, result]));
}

describe('piVersion', () => {
  it('reads the version from stdout, where pi 1.x writes it', async () => {
    expect(await piVersion(fakePi({ version: '1.1.0' }).binary)).toBe('1.1.0');
  });
});

describe('pi version range', () => {
  it('takes 1.1.0 and every later 1.x, and nothing older or of the next major', () => {
    const inRange = (text: string) => inVersionRange(parseVersion(text)!);
    expect(PI_VERSION_RANGE_TEXT).toBe('>=1.1.0 <2');
    expect(inRange('1.1.0')).toBe(true);
    expect(inRange('1.9.3')).toBe(true);
    expect(inRange('1.0.4')).toBe(false);
    expect(inRange('0.73.1')).toBe(false);
    expect(inRange('2.0.0')).toBe(false);
  });

  it('finds the version in what `pi --version` prints', () => {
    expect(parseVersion('1.1.0\n')).toEqual([1, 1, 0]);
    expect(parseVersion('pi v1.1.0 (abc)')).toEqual([1, 1, 0]);
    expect(parseVersion('no version')).toBeUndefined();
  });
});

describe('piChecks', () => {
  it('passes a pi in the range that has the model asked for', async () => {
    const checks = await check({ models: [{ provider: 'local', id: 'qwen' }], skills: ['demo'] }, { model: 'local/qwen' });
    expect(checks['pi']).toMatchObject({ ok: true, fatal: true, detail: expect.stringContaining('1.1.0') });
    expect(checks['model']).toMatchObject({ ok: true, detail: 'local/qwen' });
    expect(checks['skills']).toMatchObject({ ok: true, detail: '1 available (demo)' });
  });

  it.each(['1.0.4', '2.0.0'])('rejects pi %s, outside the range, as fatal, and probes nothing else', async (version) => {
    const checks = await check({ version });
    expect(checks['pi']).toMatchObject({ ok: false, fatal: true });
    expect(checks['pi']?.detail).toContain(`${version} is outside`);
    expect(checks['pi']?.detail).toContain(PI_VERSION_RANGE_TEXT);
    expect(checks['pi']?.detail).toContain(`npm install -g ${PI_PACKAGE}@1.1`);
    expect(Object.keys(checks)).toEqual(['pi']);
  });

  it.each(['0.73.1', '0.72.0'])('rejects pi %s as the old, deprecated package, and names the new one', async (version) => {
    const checks = await check({ version });
    expect(checks['pi']).toMatchObject({ ok: false, fatal: true });
    expect(checks['pi']?.detail).toContain('old @mariozechner/pi-coding-agent, which is deprecated');
    expect(checks['pi']?.detail).toContain(`npm install -g ${PI_PACKAGE}@1.1`);
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

  describe('browser', () => {
    const model = { model: 'stub/stub-model' };

    it('says the agent can check a screen when the command, a Chromium and the skill are there', async () => {
      const checks = await check({ skills: [BROWSER_SKILL] }, model, undefined, { browserCli: fakeBrowserCli() });
      expect(checks['browser']).toMatchObject({ ok: true, fatal: false });
      expect(checks['browser']?.detail).toContain('playwright-cli 0.1.22');
      expect(checks['browser']?.detail).toContain(BROWSER_SKILL);
    });

    it('warns, without failing, when the command is not installed, and says how to install it', async () => {
      const checks = await check({ skills: [BROWSER_SKILL] }, model, undefined, { browserCli: '/nonexistent/playwright-cli' });
      expect(checks['browser']).toMatchObject({ ok: false, fatal: false });
      expect(checks['browser']?.detail).toContain('npm install -g @playwright/cli');
    });

    it('warns when the command has no Chromium to drive', async () => {
      const checks = await check({ skills: [BROWSER_SKILL] }, model, undefined, { browserCli: fakeBrowserCli('  Browsers:\n') });
      expect(checks['browser']).toMatchObject({ ok: false, fatal: false });
      expect(checks['browser']?.detail).toContain('install-browser chromium');
    });

    it('warns when pi lists no browser skill, and points at `ralph init`', async () => {
      const checks = await check({ skills: ['demo'] }, model, undefined, { browserCli: fakeBrowserCli() });
      expect(checks['browser']).toMatchObject({ ok: false, fatal: false });
      expect(checks['browser']?.detail).toContain('ralph init');
    });

    it('does not claim a Chromium it could not look for', async () => {
      const path = resolve(mkdtempSync(resolve(tmpdir(), 'fake-playwright-cli-')), 'playwright-cli');
      writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.22; exit 0; fi\nexit 1\n');
      chmodSync(path, 0o755);
      const checks = await check({ skills: [BROWSER_SKILL] }, model, undefined, { browserCli: path });
      expect(checks['browser']).toMatchObject({ ok: true });
      expect(checks['browser']?.detail).toContain('was not checked');
    });
  });

  it('passes when pi loads the extension through which Ralph judges every tool call, with no warning left', async () => {
    const checks = await check({}, { model: 'stub/stub-model' });
    expect(checks['permissions']).toMatchObject({ ok: true, fatal: true, detail: expect.stringContaining('put to Ralph before it runs') });
    expect(checks['permissions']?.detail).not.toMatch(/not enforced/);
  });

  it('refuses pi when the extension did not load: it would run every tool call unchecked', async () => {
    const checks = await check({ gate: 'missing' }, { model: 'stub/stub-model' });
    expect(checks['permissions']).toMatchObject({ ok: false, fatal: true });
    expect(checks['permissions']?.detail).toContain('ralph-gate.mjs');
    expect(checks['permissions']?.detail).toContain('will not run pi');
  });

  it('starts its probe with the extension', async () => {
    const pi = fakePi();
    const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', model: 'stub/stub-model', pi: { binary: pi.binary } });
    await piChecks(config, { cwd: process.cwd(), logger: quietLogger });
    expect(pi.starts()[0]).toEqual(expect.arrayContaining(['--extension', GATE_EXTENSION]));
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

  it('gives pi project trust, or withholds it, explicitly', async () => {
    const trusted = fakePi();
    await check({}, {}, trusted.binary);
    expect(trusted.starts()[0]).toContain('--approve');
    const untrusted = fakePi();
    await check({}, { pi: { trustProject: false } }, untrusted.binary);
    expect(untrusted.starts()[0]).toContain('--no-approve');
    expect(untrusted.starts()[0]).not.toContain('--approve');
  });

  it('says the project\'s skills are not loaded when pi is not given project trust', async () => {
    const project = mkdtempSync(resolve(tmpdir(), 'ralph-pi-untrusted-'));
    mkdirSync(resolve(project, '.agents/skills/demo'), { recursive: true });
    writeFileSync(resolve(project, '.agents/skills/demo/SKILL.md'), '---\nname: demo\n---\n');
    const pi = fakePi();
    const config = ConfigSchema.parse({ projectRoot: project, harness: 'pi', model: 'stub/stub-model', pi: { binary: pi.binary, trustProject: false } });
    const checks = Object.fromEntries((await piChecks(config, { cwd: project, logger: quietLogger })).map((result) => [result.name, result]));
    expect(checks['skills']).toMatchObject({ ok: false, fatal: false, detail: expect.stringContaining('pi.trustProject is off') });
    expect(checks['skills']?.detail).toContain('.agents/skills');
  });

  it('is what the harness reports from its preflight', async () => {
    const pi = fakePi();
    const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', model: 'stub/stub-model', pi: { binary: pi.binary } });
    const harness = new PiHarness(config, { cwd: process.cwd(), logger: quietLogger });
    const names = (await harness.preflight(config)).map((result) => result.name);
    expect(names).toEqual(['pi', 'model', 'skills', 'browser', 'permissions', 'extensions']);
    await harness.stop();
  });

  it('stops a run, which refuses on any failed fatal check, when the extension did not load', async () => {
    const pi = fakePi({ gate: 'missing' });
    const config = ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', model: 'stub/stub-model', pi: { binary: pi.binary } });
    const harness = new PiHarness(config, { cwd: process.cwd(), logger: quietLogger });
    const blocking = (await preflight(config, harness)).filter((result) => !result.ok && result.fatal).map((result) => result.name);
    expect(blocking).toContain('permissions');
    await harness.stop();
  });
});

describe('extensionsCheck', () => {
  const config = (pi: Record<string, unknown> = {}) => ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', pi });
  const dirs = () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-pi-ext-'));
    const agent = resolve(root, 'agent');
    const project = resolve(root, 'project');
    mkdirSync(agent, { recursive: true });
    mkdirSync(project, { recursive: true });
    return { agent, project };
  };
  const withAgentDir = <T>(dir: string, run: () => T): T => {
    const before = process.env['PI_CODING_AGENT_DIR'];
    process.env['PI_CODING_AGENT_DIR'] = dir;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = before;
    }
  };

  it('passes with no extensions beyond pi\'s own and the gate', () => {
    const { agent, project } = dirs();
    expect(withAgentDir(agent, () => extensionsCheck(config(), project))).toMatchObject({ ok: true, fatal: false });
  });

  it('warns about the project\'s and the user\'s extensions, which run after the gate', () => {
    const { agent, project } = dirs();
    mkdirSync(resolve(project, '.pi/extensions'), { recursive: true });
    writeFileSync(resolve(project, '.pi/extensions/rewrite.ts'), 'export default () => {};');
    mkdirSync(resolve(agent, 'extensions'), { recursive: true });
    writeFileSync(resolve(agent, 'extensions/mine.ts'), 'export default () => {};');
    const result = withAgentDir(agent, () => extensionsCheck(config(), project));
    expect(result).toMatchObject({ ok: false, fatal: false });
    expect(result.detail).toContain(".pi/extensions/ (the project's)");
    expect(result.detail).toContain(`${resolve(agent, 'extensions')}/ (yours)`);
    expect(result.detail).toContain('after Ralph\'s permission gate');
  });

  it('leaves out the project\'s when pi is not given project trust, as pi then does not load them', () => {
    const { agent, project } = dirs();
    mkdirSync(resolve(project, '.pi/extensions'), { recursive: true });
    writeFileSync(resolve(project, '.pi/extensions/rewrite.ts'), 'export default () => {};');
    expect(withAgentDir(agent, () => extensionsCheck(config({ trustProject: false }), project))).toMatchObject({ ok: true });
  });
});
