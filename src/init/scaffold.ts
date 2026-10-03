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

/**
 * Ralph's run history (raw event streams and files that steer a live
 * process), and the scratch output of browser tools agents test with.
 */
const GITIGNORE_ENTRIES = [`${RALPH_DIR}/history/`, '.playwright-mcp/'];
/** Two machines appending to the same record merge by keeping both sides' lines. */
const GITATTRIBUTES_ENTRIES = [`${RALPH_DIR}/**/*.jsonl merge=union`];

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

  for (const [file, entries, has] of [
    ['.gitignore', GITIGNORE_ENTRIES, ignores],
    ['.gitattributes', GITATTRIBUTES_ENTRIES, attributes],
  ] as const) {
    const outcome = addLines(resolve(root, file), entries, has);
    ({ created, updated, skipped })[outcome].push(file);
  }

  return { status: 'scaffolded', created, updated, skipped };
}

/**
 * Add the lines `content` lacks to the end of `path`, creating it if need be.
 * Never removes or reorders a line.
 */
function addLines(
  path: string,
  entries: readonly string[],
  has: (content: string, entry: string) => boolean,
): 'created' | 'updated' | 'skipped' {
  if (!existsSync(path)) {
    writeFileSync(path, `${entries.join('\n')}\n`);
    return 'created';
  }
  const content = readFileSync(path, 'utf8');
  const missing = entries.filter((entry) => !has(content, entry));
  if (missing.length === 0) return 'skipped';
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${content}${separator}${missing.join('\n')}\n`);
  return 'updated';
}

/** Whether a .gitignore already lists the entry, allowing for a leading or missing trailing slash. */
function ignores(content: string, entry: string): boolean {
  const normalise = (line: string) => line.trim().replace(/^\//, '').replace(/\/$/, '');
  const wanted = normalise(entry);
  return content.split(/\r?\n/).some((line) => normalise(line) === wanted);
}

/** Whether a .gitattributes already sets attributes for the entry's pattern, whichever they are. */
function attributes(content: string, entry: string): boolean {
  const pattern = (line: string) => line.trim().split(/\s+/)[0]?.replace(/^\//, '');
  const wanted = pattern(entry);
  return content.split(/\r?\n/).some((line) => pattern(line) === wanted);
}
