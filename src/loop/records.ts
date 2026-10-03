import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeJournal } from '../report/journal.js';

const run = promisify(execFile);

/** When Ralph commits its own records: after each iteration, once a run ends, or never. */
export type RecordsMode = 'iteration' | 'end' | 'never';

/**
 * What Ralph writes in its folder that the next run, on this machine or
 * another, depends on: what people answered, handoffs, assessments, split
 * proposals, run journals and the evidence the agent kept. Never `history/`,
 * which holds raw event streams and files that steer a live process.
 */
export function recordPaths(ralphDir: string): string[] {
  const dir = ralphDir.replace(/\/+$/, '');
  return ['decisions.jsonl', 'handoff', 'assess', 'split', 'journal', 'artifacts'].map((path) => `${dir}/${path}`);
}

/** Where run journals are kept: what each run did, in a form fit for git. */
export function journalDir(ralphDir: string): string {
  return `${ralphDir.replace(/\/+$/, '')}/journal`;
}

export interface RecordsCommit {
  committed: boolean;
  /** Files the commit changed; none when there was nothing to commit. */
  files: string[];
  /** Why there is no commit, when there should have been one. */
  error?: string;
}

/**
 * Commit Ralph's records, and nothing else, as a commit of their own. Does
 * nothing outside a git repository or when the records are unchanged. The
 * caller picks a moment outside an iteration's before/after snapshots, so the
 * commit is never taken for the agent's progress. With `runId`, that run's
 * journal is written first and goes in the same commit.
 */
export async function commitRecords(args: {
  projectRoot: string;
  ralphDir: string;
  subject: string;
  /** A run whose journal to bring up to date first. */
  runId?: string;
}): Promise<RecordsCommit> {
  const { projectRoot } = args;
  if (!(await isRepository(projectRoot))) return { committed: false, files: [] };
  if (args.runId) writeJournal(resolve(projectRoot, args.ralphDir), args.runId);
  const paths = recordPaths(args.ralphDir);
  const files = await changedFiles(projectRoot, paths);
  if (files.length === 0) return { committed: false, files };
  const error = await commitPaths(projectRoot, paths, args.subject);
  return { committed: error === undefined, files, ...(error ? { error } : {}) };
}

/** Files under `paths` that differ from HEAD, untracked ones included; ignored ones are not. */
export async function changedFiles(cwd: string, paths: string[]): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], { cwd });
    return stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.slice(3).replace(/^.* -> /, ''));
  } catch {
    return [];
  }
}

/** Stage and commit just these paths; returns why that failed, if it did. */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<string | undefined> {
  if (!(await isRepository(cwd))) return 'not a git repository';
  try {
    // A moved file that was never tracked matches nothing and would fail the whole add.
    const known: string[] = [];
    for (const path of paths) {
      if (existsSync(resolve(cwd, path)) || (await git(cwd, ['ls-files', '--', path])) !== '') known.push(path);
    }
    if (known.length === 0) return 'nothing to commit';
    await run('git', ['add', '-A', '--', ...known], { cwd });
    await run('git', ['commit', '-q', '-m', message, '--only', '--', ...known], { cwd });
    return undefined;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    return (error.stderr || error.message).trim().split('\n')[0];
  }
}

export async function isRepository(cwd: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--git-dir'], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd });
    return stdout.trimEnd();
  } catch {
    return '';
  }
}
