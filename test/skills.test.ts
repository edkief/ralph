import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPacks, installCommands, PACKS, resolvePacks, SKILLS_CLI, UnknownPackError } from '../src/skills/packs.js';
import { describePacks, installPacks, runSkills, type CommandRunner } from '../src/skills/command.js';
import { ExitCode } from '../src/exit.js';

function project(files: Record<string, unknown> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-skills-'));
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(resolve(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const names = (packs: Array<{ name: string }>) => packs.map((pack) => pack.name);

/** A runner that records what it was asked to run and fails for the repositories named. */
function fakeRunner(failing: string[] = []): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: string[]) => {
    calls.push(argv);
    if (failing.includes(argv[4]!)) {
      throw Object.assign(new Error('Command failed'), { stdout: '', stderr: `could not clone ${argv[4]}` });
    }
    return { stdout: 'Done!', stderr: '' };
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('packs', () => {
  it('have unique names and draw only on owner/repo sources', () => {
    expect(new Set(names(PACKS)).size).toBe(PACKS.length);
    for (const pack of PACKS) {
      for (const source of pack.sources) {
        expect(source.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
        expect(source.skills.length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves names once each, ignoring case, and rejects unknown ones', () => {
    expect(names(resolvePacks(['Postgres', 'react', 'postgres', ' ']))).toEqual(['postgres', 'react']);
    expect(() => resolvePacks(['react', 'drizzle'])).toThrow(UnknownPackError);
    expect(() => resolvePacks(['drizzle'])).toThrow(/Unknown pack: drizzle\. Packs: react, shadcn/);
  });

  it('detects packs from dependencies, devDependencies and marker files', () => {
    const root = project({
      'package.json': {
        dependencies: { next: '15.0.0', '@prisma/client': '6.0.0', pg: '8.0.0', 'drizzle-orm': '0.40.0' },
        devDependencies: { vitest: '3.0.0' },
      },
      'components.json': {},
    });
    expect(names(detectPacks(root))).toEqual(['react', 'shadcn', 'vitest', 'postgres', 'prisma']);
  });

  it('detects nothing without manifests, or from one that does not parse', () => {
    expect(detectPacks(project())).toEqual([]);
    expect(detectPacks(project({ 'package.json': '{ not json' }))).toEqual([]);
  });

  it('installs with one pinned, non-interactive command per repository', () => {
    expect(installCommands(resolvePacks(['react', 'postgres', 'mysql']))).toEqual([
      [
        'npx', '-y', SKILLS_CLI, 'add', 'vercel-labs/agent-skills',
        '-s', 'vercel-react-best-practices', '-s', 'vercel-composition-patterns', '-s', 'web-design-guidelines', '-y',
      ],
      ['npx', '-y', SKILLS_CLI, 'add', 'planetscale/database-skills', '-s', 'postgres', '-s', 'mysql', '-y'],
    ]);
  });
});

describe('installPacks', () => {
  it('runs every command in the project and reports each', async () => {
    const root = project();
    const run = fakeRunner();
    const result = await installPacks(root, resolvePacks(['react', 'postgres']), run);
    expect(result.ok).toBe(true);
    expect(run.calls.map((argv) => argv[4])).toEqual(['vercel-labs/agent-skills', 'planetscale/database-skills']);
    expect(result.report).toHaveLength(2);
    expect(result.report[0]).toMatch(/^ {2}✓ npx -y skills@/);
  });

  it('keeps going past a failure, and reports it with the CLI output', async () => {
    const run = fakeRunner(['vercel-labs/agent-skills']);
    const result = await installPacks(project(), resolvePacks(['react', 'postgres']), run);
    expect(result.ok).toBe(false);
    expect(run.calls).toHaveLength(2);
    expect(result.report.join('\n')).toContain('✗ npx -y skills@1.7.2 add vercel-labs/agent-skills');
    expect(result.report.join('\n')).toContain('could not clone vercel-labs/agent-skills');
  });
});

describe('ralph skills', () => {
  const output = () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      out: () => out.mock.calls.map((call) => String(call[0])).join(''),
      err: () => err.mock.calls.map((call) => String(call[0])).join(''),
    };
  };

  it('lists every pack, marks those the project suggests, and prints their install commands', () => {
    const text = describePacks(project({ 'package.json': { dependencies: { react: '19.0.0', mysql2: '3.0.0' } } }));
    for (const pack of PACKS) expect(text).toContain(pack.name);
    expect(text).toMatch(/react .*\[detected\]/);
    expect(text).not.toMatch(/postgres .*\[detected\]/);
    expect(text).toContain('This project suggests: react, mysql. Install with `ralph skills add react mysql`');
    expect(text).toContain(`npx -y ${SKILLS_CLI} add planetscale/database-skills -s mysql -y`);
  });

  it('says when nothing is detected', () => {
    expect(describePacks(project())).toContain('Nothing in this project suggests a pack');
  });

  it('installs the packs named, comma- or space-separated', async () => {
    const io = output();
    const run = fakeRunner();
    expect(await runSkills({ projectRoot: project(), positionals: ['add', 'react,vitest', 'shadcn'], run })).toBe(0);
    expect(run.calls.map((argv) => argv[4])).toEqual(['vercel-labs/agent-skills', 'antfu/skills', 'shadcn/ui']);
    expect(io.out()).toContain('Installing react, vitest, shadcn');
  });

  it('fails without running anything for an unknown pack, no pack, or an unknown action', async () => {
    const io = output();
    const run = fakeRunner();
    expect(await runSkills({ projectRoot: project(), positionals: ['add', 'drizzle'], run })).toBe(ExitCode.ConfigError);
    expect(await runSkills({ projectRoot: project(), positionals: ['add'], run })).toBe(ExitCode.ConfigError);
    expect(await runSkills({ projectRoot: project(), positionals: ['remove', 'react'], run })).toBe(ExitCode.ConfigError);
    expect(run.calls).toEqual([]);
    expect(io.err()).toContain('Unknown pack: drizzle');
  });

  it('exits non-zero with the CLI output when an install fails', async () => {
    const io = output();
    const run = fakeRunner(['planetscale/database-skills']);
    expect(await runSkills({ projectRoot: project(), positionals: ['add', 'postgres'], run })).toBe(ExitCode.ConfigError);
    expect(io.err()).toContain('could not clone planetscale/database-skills');
  });
});
