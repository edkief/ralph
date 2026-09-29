import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_DIR, RALPH_DIR } from '../config/load.js';

/**
 * Shipped next to `src/` and `dist/` alike: both sit one level below the
 * package root, so the same relative URL works from either.
 */
export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

/** Template file → destination, relative to the project root. */
const FILES: ReadonlyArray<readonly [template: string, destination: string]> = [
  ['PROMPT.md', `${RALPH_DIR}/PROMPT.md`],
  ['tasks.json', `${RALPH_DIR}/tasks.json`],
  ['PRD.md', `${RALPH_DIR}/prd/PRD.md`],
  ['STEERING.md', `${RALPH_DIR}/STEERING.md`],
  ['TASK-1.json', `${RALPH_DIR}/tasks/TASK-1.json`],
  ['LOG.md', `${RALPH_DIR}/logs/LOG.md`],
  ['ralph.config.json', 'ralph.config.json'],
];

const GITIGNORE_ENTRY = `${RALPH_DIR}/history/`;

export type ScaffoldResult =
  | { status: 'scaffolded'; created: string[]; updated: string[]; skipped: string[] }
  | { status: 'legacy'; message: string };

/**
 * Lay out a new `.ralph/` project from the templates. Never overwrites: a file
 * that already exists is skipped, so running it again changes nothing.
 * A project still on `.agent/` is left alone for the user to rename.
 */
export function scaffold(projectRoot: string, templatesDir = TEMPLATES_DIR): ScaffoldResult {
  const root = resolve(projectRoot);
  if (existsSync(resolve(root, LEGACY_DIR)) && !existsSync(resolve(root, RALPH_DIR))) {
    return {
      status: 'legacy',
      message:
        `${LEGACY_DIR}/ found: this project predates ${RALPH_DIR}/. Rename it instead of scaffolding:\n` +
        `  git mv ${LEGACY_DIR} ${RALPH_DIR}`,
    };
  }

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const [template, destination] of FILES) {
    const target = resolve(root, destination);
    if (existsSync(target)) {
      skipped.push(destination);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(templatesDir, template), target);
    created.push(destination);
  }

  const gitignore = resolve(root, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, `${GITIGNORE_ENTRY}\n`);
    created.push('.gitignore');
  } else {
    const content = readFileSync(gitignore, 'utf8');
    if (ignores(content, GITIGNORE_ENTRY)) {
      skipped.push('.gitignore');
    } else {
      const separator = content === '' || content.endsWith('\n') ? '' : '\n';
      writeFileSync(gitignore, `${content}${separator}${GITIGNORE_ENTRY}\n`);
      updated.push('.gitignore');
    }
  }

  return { status: 'scaffolded', created, updated, skipped };
}

/** Whether a .gitignore already lists the entry, allowing for a leading or missing trailing slash. */
function ignores(content: string, entry: string): boolean {
  const normalise = (line: string) => line.trim().replace(/^\//, '').replace(/\/$/, '');
  const wanted = normalise(entry);
  return content.split(/\r?\n/).some((line) => normalise(line) === wanted);
}
