import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commitPaths, isRepository } from '../loop/records.js';
import { writePlanJournal } from '../report/journal.js';
import { TaskStore } from '../tasks/store.js';
import type { PlanMode } from './record.js';

/** What a plan is made of, in the Ralph folder: the files the planning agent writes. */
const PLAN_PATHS = ['prd', 'tasks.json', 'tasks'];
/** The owner's request is quoted in the commit message up to this length. */
const MAX_REQUEST = 2_000;

/** Each task by id: its title, and what tells whether the plan changed it (its entry and spec). */
export type TaskSnapshot = Map<string, { title: string; fingerprint: string }>;

/** The tasks as they are now; none when tasks.json is missing or unreadable. */
export function snapshotTasks(projectRoot: string, ralphDir: string): TaskSnapshot {
  const snapshot: TaskSnapshot = new Map();
  try {
    for (const task of TaskStore.forProject(projectRoot, ralphDir).readTasks()) {
      const spec = task.specFilePath ? readText(resolve(projectRoot, task.specFilePath)) : '';
      snapshot.set(task.id, { title: task.title, fingerprint: `${JSON.stringify(task)}\0${spec}` });
    }
  } catch {
    // No plan to compare with: every task is new.
  }
  return snapshot;
}

export interface PlanCommit {
  committed: boolean;
  subject: string;
  /** Why there is no commit, when there should have been one. */
  error?: string;
}

/**
 * Commit a plan that passed validation, as a commit of its own: the PRD, the
 * task list and specs, what the scaffold laid out for it, and the session's
 * journal, the record of why the plan is what it is. The message says what
 * the owner asked for and which tasks the plan added, removed and changed.
 * Nothing else is taken, staged or not. Undefined outside a git repository.
 */
export async function commitPlan(args: {
  projectRoot: string;
  ralphDir: string;
  planId: string;
  mode: PlanMode;
  /** The owner's description, or what they wanted changed. */
  request?: string;
  /** The tasks before the session. */
  before: TaskSnapshot;
  /** Files the scaffold created or updated for this session, relative to the project root. */
  scaffolded?: readonly string[];
}): Promise<PlanCommit | undefined> {
  const { projectRoot, ralphDir, planId } = args;
  if (!(await isRepository(projectRoot))) return undefined;
  const subject = `chore(ralph): ${args.mode === 'replan' ? 'replan' : 'plan'} ${planId}`;
  try {
    writePlanJournal(resolve(projectRoot, ralphDir), planId);
    const dir = ralphDir.replace(/\/+$/, '');
    const paths = [...PLAN_PATHS.map((path) => `${dir}/${path}`), `${dir}/journal/plans/${planId}`, ...(args.scaffolded ?? [])];
    const after = snapshotTasks(projectRoot, ralphDir);
    const error = await commitPaths(projectRoot, paths, planMessage(subject, `${dir}/journal/plans/${planId}/`, args.request, args.before, after));
    if (error === 'nothing to commit') return { committed: false, subject };
    return error ? { committed: false, subject, error } : { committed: true, subject };
  } catch (cause) {
    return { committed: false, subject, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The commit message: the subject, what was asked, where the journal is, and the tasks it touched. */
export function planMessage(subject: string, journal: string, request: string | undefined, before: TaskSnapshot, after: TaskSnapshot): string {
  const named = (snapshot: TaskSnapshot, ids: string[]) => ids.map((id) => `- ${id}${snapshot.get(id)?.title ? ` ${snapshot.get(id)!.title}` : ''}`);
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id)!.fingerprint !== after.get(id)!.fingerprint);
  const sections: string[][] = [];
  const asked = request?.trim();
  if (asked) {
    const clipped = asked.length <= MAX_REQUEST ? asked : `${asked.slice(0, MAX_REQUEST)}… (${asked.length - MAX_REQUEST} more characters)`;
    sections.push(['The owner asked:', '', ...clipped.split('\n').map((line) => `> ${line}`.trimEnd())]);
  }
  if (added.length > 0) sections.push(['Added:', ...named(after, added)]);
  if (removed.length > 0) sections.push(['Removed:', ...named(before, removed)]);
  if (changed.length > 0) sections.push(['Changed:', ...named(after, changed)]);
  sections.push([`The conversation is in ${journal}`]);
  return [subject, ...sections.map((lines) => lines.join('\n'))].join('\n\n');
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
