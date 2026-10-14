import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The `skills` CLI (https://github.com/vercel-labs/skills) does the
 * installing. Pinned, so a pack installs the same way until Ralph moves it on.
 */
export const SKILLS_CLI = 'skills@1.7.2';

/** Skills from one upstream repository, as `npx skills add <repo>` names it. */
export interface PackSource {
  repo: string;
  skills: string[];
}

/**
 * A curated set of upstream skills for one part of a stack. Ralph only picks
 * them; the `skills` CLI fetches them from their maintainers, so they stay
 * current, and installing anything else, updating or removing stays with it.
 */
export interface Pack {
  name: string;
  description: string;
  sources: PackSource[];
  /** Dependencies in package.json any one of which suggests the pack. */
  dependencies?: string[];
  /** Files at the project root any one of which suggests the pack. */
  files?: string[];
}

/** First-party sources only: maintained by the people who make the tool. */
export const PACKS: readonly Pack[] = [
  {
    name: 'react',
    description: 'React and Next.js performance, component composition, web interface guidelines (Vercel)',
    sources: [
      {
        repo: 'vercel-labs/agent-skills',
        skills: ['vercel-react-best-practices', 'vercel-composition-patterns', 'web-design-guidelines'],
      },
    ],
    dependencies: ['react', 'next'],
  },
  {
    name: 'shadcn',
    description: 'shadcn/ui components, registries and styling (shadcn)',
    sources: [{ repo: 'shadcn/ui', skills: ['shadcn'] }],
    files: ['components.json'],
  },
  {
    name: 'vitest',
    description: 'Vitest tests, mocking and configuration (Anthony Fu, Vitest team)',
    sources: [{ repo: 'antfu/skills', skills: ['vitest'] }],
    dependencies: ['vitest'],
  },
  {
    name: 'postgres',
    description: 'PostgreSQL schema, indexing, queries and operations (PlanetScale)',
    sources: [{ repo: 'planetscale/database-skills', skills: ['postgres'] }],
    dependencies: ['pg', 'postgres', '@neondatabase/serverless', '@vercel/postgres'],
  },
  {
    name: 'mysql',
    description: 'MySQL/InnoDB schema, indexing, queries and operations (PlanetScale)',
    sources: [{ repo: 'planetscale/database-skills', skills: ['mysql'] }],
    dependencies: ['mysql2'],
  },
  {
    name: 'prisma',
    description: 'Prisma CLI, migrations and Prisma Client queries (Prisma)',
    sources: [{ repo: 'prisma/skills', skills: ['prisma-cli', 'prisma-client-api'] }],
    dependencies: ['prisma', '@prisma/client'],
  },
];

export class UnknownPackError extends Error {
  constructor(names: string[]) {
    super(
      `Unknown pack${names.length === 1 ? '' : 's'}: ${names.join(', ')}. ` +
        `Packs: ${PACKS.map((pack) => pack.name).join(', ')}. For any other skill, use \`npx skills\`.`,
    );
  }
}

/** The packs named, in the order given, once each. Throws on a name that is not a pack. */
export function resolvePacks(names: string[]): Pack[] {
  const wanted = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];
  const unknown = wanted.filter((name) => !PACKS.some((pack) => pack.name === name));
  if (unknown.length > 0) throw new UnknownPackError(unknown);
  return wanted.map((name) => PACKS.find((pack) => pack.name === name)!);
}

/**
 * The packs a project's manifests suggest: its package.json dependencies and
 * devDependencies, and marker files at its root. Nothing for a project without
 * them, or with a package.json that does not parse.
 */
export function detectPacks(projectRoot: string): Pack[] {
  const dependencies = new Set<string>();
  const manifest = resolve(projectRoot, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies']) {
        const deps = pkg[field];
        if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) dependencies.add(name);
      }
    } catch {
      // An unreadable manifest suggests nothing.
    }
  }
  return PACKS.filter(
    (pack) =>
      pack.dependencies?.some((name) => dependencies.has(name)) ||
      pack.files?.some((file) => existsSync(resolve(projectRoot, file))),
  );
}

/** Whether every skill of the pack is already in the project's `.agents/skills/`. */
export function isInstalled(projectRoot: string, pack: Pack): boolean {
  return pack.sources.every((source) =>
    source.skills.every((skill) => existsSync(resolve(projectRoot, '.agents', 'skills', skill, 'SKILL.md'))),
  );
}

/**
 * One `npx skills add` per repository the packs draw on, with every skill
 * wanted from it. No `--agent`: the CLI installs to `.agents/skills/`, which
 * most agents read, and links the skills for those on this machine that do
 * not. `-y` keeps it from asking.
 */
export function installCommands(packs: Pack[]): string[][] {
  const byRepo = new Map<string, Set<string>>();
  for (const source of packs.flatMap((pack) => pack.sources)) {
    const skills = byRepo.get(source.repo) ?? new Set<string>();
    for (const skill of source.skills) skills.add(skill);
    byRepo.set(source.repo, skills);
  }
  return [...byRepo].map(([repo, skills]) => [
    'npx',
    '-y',
    SKILLS_CLI,
    'add',
    repo,
    ...[...skills].flatMap((skill) => ['-s', skill]),
    '-y',
  ]);
}
