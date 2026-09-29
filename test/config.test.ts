import { mkdtempSync, writeFileSync } from 'node:fs';
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
