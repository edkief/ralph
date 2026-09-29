import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffold, TEMPLATES_DIR } from '../src/init/scaffold.js';
import { loadConfig } from '../src/config/load.js';
import { TaskStore } from '../src/tasks/store.js';

const EXPECTED = [
  '.ralph/PROMPT.md',
  '.ralph/tasks.json',
  '.ralph/prd/PRD.md',
  '.ralph/STEERING.md',
  '.ralph/tasks/TASK-1.json',
  '.ralph/logs/LOG.md',
  'ralph.config.json',
];

function project(): string {
  return mkdtempSync(resolve(tmpdir(), 'ralph-init-'));
}

/** Every file under root with its content and mtime, to prove a rerun touches nothing. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = `${statSync(path).mtimeMs}:${readFileSync(path, 'utf8')}`;
    }
  };
  walk(root);
  return out;
}

describe('scaffold', () => {
  it('finds the templates relative to the module', () => {
    expect(existsSync(resolve(TEMPLATES_DIR, 'PROMPT.md'))).toBe(true);
  });

  it('creates every file in a fresh project', () => {
    const root = project();
    const result = scaffold(root);

    expect(result.status).toBe('scaffolded');
    if (result.status !== 'scaffolded') return;
    expect(result.created).toEqual([...EXPECTED, '.gitignore']);
    expect(result.skipped).toEqual([]);
    for (const path of EXPECTED) {
      expect(readFileSync(resolve(root, path), 'utf8')).not.toBe('');
    }
    expect(readFileSync(resolve(root, '.gitignore'), 'utf8')).toBe('.ralph/history/\n');
  });

  it('produces a project Ralph can load', () => {
    const root = project();
    scaffold(root);

    const warnings: string[] = [];
    const config = loadConfig({ projectRoot: root, env: {}, onWarning: (m) => warnings.push(m) });
    expect(config.ralphDir).toBe('.ralph');
    expect(warnings).toEqual([]);

    const next = TaskStore.forProject(root, config.ralphDir).reload().next;
    expect(next?.id).toBe('TASK-1');
    expect(existsSync(resolve(root, next?.specFilePath ?? 'missing'))).toBe(true);
    const spec = JSON.parse(readFileSync(resolve(root, next?.specFilePath ?? ''), 'utf8'));
    expect(spec.id).toBe(next?.id);
  });

  it('changes nothing when run a second time', () => {
    const root = project();
    scaffold(root);
    const before = snapshot(root);

    const result = scaffold(root);

    expect(result).toEqual({
      status: 'scaffolded',
      created: [],
      updated: [],
      skipped: [...EXPECTED, '.gitignore'],
    });
    expect(snapshot(root)).toEqual(before);
  });

  it('never overwrites an existing file', () => {
    const root = project();
    mkdirSync(resolve(root, '.ralph/prd'), { recursive: true });
    writeFileSync(resolve(root, '.ralph/PROMPT.md'), 'my prompt');
    writeFileSync(resolve(root, '.ralph/prd/PRD.md'), 'my prd');
    writeFileSync(resolve(root, 'ralph.config.json'), '{"maxIterations": 3}');

    const result = scaffold(root);

    expect(result.status === 'scaffolded' && result.skipped).toEqual([
      '.ralph/PROMPT.md',
      '.ralph/prd/PRD.md',
      'ralph.config.json',
    ]);
    expect(readFileSync(resolve(root, '.ralph/PROMPT.md'), 'utf8')).toBe('my prompt');
    expect(readFileSync(resolve(root, '.ralph/prd/PRD.md'), 'utf8')).toBe('my prd');
    expect(readFileSync(resolve(root, 'ralph.config.json'), 'utf8')).toBe('{"maxIterations": 3}');
    expect(existsSync(resolve(root, '.ralph/tasks.json'))).toBe(true);
  });

  it('adds the history line to an existing .gitignore exactly once', () => {
    const root = project();
    writeFileSync(resolve(root, '.gitignore'), 'node_modules/\ndist/');

    const first = scaffold(root);
    scaffold(root);

    expect(first.status === 'scaffolded' && first.updated).toEqual(['.gitignore']);
    expect(readFileSync(resolve(root, '.gitignore'), 'utf8')).toBe(
      'node_modules/\ndist/\n.ralph/history/\n',
    );
  });

  it('recognises an equivalent .gitignore entry already present', () => {
    const root = project();
    writeFileSync(resolve(root, '.gitignore'), '/.ralph/history\n');

    const result = scaffold(root);

    expect(result.status === 'scaffolded' && result.skipped).toContain('.gitignore');
    expect(readFileSync(resolve(root, '.gitignore'), 'utf8')).toBe('/.ralph/history\n');
  });

  it('refuses to scaffold over a legacy .agent folder', () => {
    const root = project();
    mkdirSync(resolve(root, '.agent'));
    writeFileSync(resolve(root, '.agent/PROMPT.md'), 'legacy');

    const result = scaffold(root);

    expect(result.status).toBe('legacy');
    expect(result.status === 'legacy' && result.message).toContain('git mv .agent .ralph');
    expect(readdirSync(root).sort()).toEqual(['.agent']);
  });

  it('scaffolds normally once .ralph exists alongside .agent', () => {
    const root = project();
    mkdirSync(resolve(root, '.agent'));
    mkdirSync(resolve(root, '.ralph'));

    expect(scaffold(root).status).toBe('scaffolded');
  });
});
