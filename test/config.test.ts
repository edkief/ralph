import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config/load.js';

function project(): string {
  return mkdtempSync(resolve(tmpdir(), 'ralph-config-'));
}

describe('loadConfig', () => {
  it('applies defaults when nothing is configured', () => {
    const config = loadConfig({ projectRoot: project(), env: {} });
    expect(config.maxIterations).toBe(10);
    expect(config.timeouts.inactivityMs).toBe(180_000);
    expect(config.permissions.deny).toContain('git push');
  });

  it('layers file < env < flags', () => {
    const root = project();
    writeFileSync(
      resolve(root, 'ralph.config.json'),
      JSON.stringify({ maxIterations: 5, model: 'file/model', agent: 'file-agent' }),
    );

    const config = loadConfig({
      projectRoot: root,
      env: { RALPH_MAX_ITERATIONS: '7', RALPH_MODEL: 'env/model' },
      overrides: { maxIterations: 3 },
    });

    expect(config.maxIterations).toBe(3);
    expect(config.model).toBe('env/model');
    expect(config.agent).toBe('file-agent');
  });

  it('merges nested sections without dropping siblings', () => {
    const root = project();
    writeFileSync(
      resolve(root, 'ralph.config.json'),
      JSON.stringify({ timeouts: { iterationMs: 1_000 } }),
    );

    const config = loadConfig({
      projectRoot: root,
      env: { RALPH_INACTIVITY_TIMEOUT_MS: '2000' },
    });

    expect(config.timeouts.iterationMs).toBe(1_000);
    expect(config.timeouts.inactivityMs).toBe(2_000);
  });

  it('gives the agent a wrap-up budget unless it is turned off', () => {
    expect(loadConfig({ projectRoot: project(), env: {} }).timeouts.wrapUpMs).toBe(600_000);
    const off = loadConfig({ projectRoot: project(), env: { RALPH_WRAP_UP_TIMEOUT_MS: '0' } });
    expect(off.timeouts.wrapUpMs).toBe(0);
  });

  it('keeps the web UI off and on loopback unless asked', () => {
    expect(loadConfig({ projectRoot: project(), env: {} }).ui).toEqual({ enabled: false, host: '127.0.0.1', port: 4280, basePath: '' });
    const fromEnv = loadConfig({
      projectRoot: project(),
      env: { RALPH_UI: '1', RALPH_UI_HOST: '0.0.0.0', RALPH_UI_PORT: '8080', RALPH_UI_BASE_PATH: '/ralph/ws-1' },
    });
    expect(fromEnv.ui).toEqual({ enabled: true, host: '0.0.0.0', port: 8080, basePath: '/ralph/ws-1' });
    const fromFlags = loadConfig({
      projectRoot: project(),
      env: { RALPH_UI: '1' },
      overrides: { ui: { enabled: false, port: 9000 } },
    });
    expect(fromFlags.ui).toEqual({ enabled: false, host: '127.0.0.1', port: 9000, basePath: '' });
    expect(() =>
      loadConfig({ projectRoot: project(), env: { RALPH_UI_BASE_PATH: 'ralph' } }),
    ).toThrow(/basePath/);
  });

  it('rejects invalid values with a readable message', () => {
    const root = project();
    writeFileSync(resolve(root, 'ralph.config.json'), JSON.stringify({ maxIterations: -1 }));
    expect(() => loadConfig({ projectRoot: root, env: {} })).toThrow(ConfigError);
  });

  it('rejects malformed config files', () => {
    const root = project();
    writeFileSync(resolve(root, 'ralph.config.json'), '{not json');
    expect(() => loadConfig({ projectRoot: root, env: {} })).toThrow(/Could not parse/);
  });
});

describe('ralphDir resolution', () => {
  function load(root: string, options: { env?: NodeJS.ProcessEnv; overrides?: Record<string, unknown> } = {}) {
    const warnings: string[] = [];
    const config = loadConfig({
      projectRoot: root,
      env: options.env ?? {},
      ...(options.overrides ? { overrides: options.overrides } : {}),
      onWarning: (message) => warnings.push(message),
    });
    return { config, warnings };
  }

  it('defaults to .ralph when the project has neither folder', () => {
    const { config, warnings } = load(project());
    expect(config.ralphDir).toBe('.ralph');
    expect(warnings).toEqual([]);
  });

  it('uses an existing .ralph folder', () => {
    const root = project();
    mkdirSync(resolve(root, '.ralph'));
    mkdirSync(resolve(root, '.agent'));
    const { config, warnings } = load(root);
    expect(config.ralphDir).toBe('.ralph');
    expect(warnings).toEqual([]);
  });

  it('falls back to a legacy .agent folder with a deprecation warning', () => {
    const root = project();
    mkdirSync(resolve(root, '.agent'));
    const { config, warnings } = load(root);
    expect(config.ralphDir).toBe('.agent');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\.agent\/ is deprecated.*git mv \.agent \.ralph/);
  });

  it('lets an explicit ralphDir win over folders on disk', () => {
    const root = project();
    mkdirSync(resolve(root, '.ralph'));
    mkdirSync(resolve(root, '.agent'));
    writeFileSync(resolve(root, 'ralph.config.json'), JSON.stringify({ ralphDir: 'from-file' }));

    expect(load(root).config.ralphDir).toBe('from-file');
    expect(load(root, { env: { RALPH_DIR: 'from-env' } }).config.ralphDir).toBe('from-env');
    expect(
      load(root, { env: { RALPH_DIR: 'from-env' }, overrides: { ralphDir: 'from-flag' } }).config.ralphDir,
    ).toBe('from-flag');
  });

  it('accepts agentDir as a deprecated alias and drops it from the result', () => {
    const root = project();
    mkdirSync(resolve(root, '.ralph'));
    writeFileSync(resolve(root, 'ralph.config.json'), JSON.stringify({ agentDir: 'legacy' }));

    const { config, warnings } = load(root);
    expect(config.ralphDir).toBe('legacy');
    expect(config).not.toHaveProperty('agentDir');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"agentDir" setting is deprecated/);
  });

  it('prefers ralphDir when both keys are set', () => {
    const root = project();
    writeFileSync(
      resolve(root, 'ralph.config.json'),
      JSON.stringify({ agentDir: 'legacy', ralphDir: 'current' }),
    );
    const { config, warnings } = load(root);
    expect(config.ralphDir).toBe('current');
    expect(warnings[0]).toMatch(/using "ralphDir"/);
  });
});
