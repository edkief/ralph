import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A handoff is the note an agent leaves when an iteration runs out of time or
 * context, so the next attempt at the task resumes instead of starting over. It lives
 * at `<ralphDir>/handoff/<taskId>.md` and uses these headings.
 */
export const HANDOFF_HEADINGS = [
  'Status',
  'Done',
  'Working tree',
  'Next steps',
  'Dead ends',
  'How to verify',
] as const;

/** The most of a handoff that goes into a prompt. */
const MAX_PROMPT_BYTES = 8_000;
/** The most of an earlier handoff, or of the agent's last words, kept in a fallback. */
const MAX_QUOTED_CHARS = 3_000;

/**
 * What an attempt ran out of, `park` when a person parked the run, or
 * `early-stop` when the agent ended its turn with time left and the task not done.
 */
export type CutShortBy = 'time' | 'context' | 'park' | 'early-stop';

/** For the attempt after one whose conversation outgrew the model's context window. */
const CONTEXT_ADVICE = [
  `The last attempt filled the model's context window. Keep this one lean: read files in`,
  `ranges rather than whole, trim command output (\`| tail -n 50\`, quiet test reporters), avoid`,
  `re-reading what you already know, and commit each working step so little rides on one session.`,
].join('\n');

/** For the attempt after one whose agent ended its turn with the task unfinished. */
const EARLY_STOP_ADVICE = [
  `The last attempt ended its turn with work left, often to wait for a background job such as a test`,
  `run. Nothing resumes a session once its turn ends: if the last messages mention a job that was still`,
  `running, run it again, and wait for long commands in the foreground before ending your turn.`,
].join('\n');

export function handoffDir(ralphDir: string): string {
  return `${ralphDir.replace(/\/+$/, '')}/handoff`;
}

export function handoffPath(projectRoot: string, ralphDir: string, taskId: string): string {
  return resolve(projectRoot, handoffDir(ralphDir), `${taskId}.md`);
}

/** The headings a handoff lacks; empty when it has them all. */
export function missingHeadings(text: string): string[] {
  return HANDOFF_HEADINGS.filter(
    (heading) => !new RegExp(`^#{2,3}\\s+${heading}\\s*$`, 'im').test(text),
  );
}

/** The handoff for a prompt, trimmed to a size that leaves room for the rest. */
export function readHandoff(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').trim();
  if (text === '') return undefined;
  if (Buffer.byteLength(text) <= MAX_PROMPT_BYTES) return text;
  return `${Buffer.from(text).subarray(0, MAX_PROMPT_BYTES).toString('utf8')}\n\n[… handoff truncated]`;
}

/**
 * Make sure an attempt that was cut short leaves a usable handoff. The agent's own is
 * kept when it was written during this attempt and has every heading;
 * otherwise Ralph writes one from what it saw, keeping whatever was there.
 */
export async function ensureHandoff(args: {
  path: string;
  projectRoot: string;
  taskId: string;
  iteration: number;
  /** When the attempt started, to tell a fresh handoff from a stale one. */
  since: number;
  /** HEAD when the iteration started, to list the commits it made. */
  sinceHead: string | null;
  reason: string;
  /** What the attempt ran out of, which shapes the advice for the next one. */
  cutShortBy?: CutShortBy;
  agentText: string;
}): Promise<'agent' | 'fallback'> {
  const existing = existsSync(args.path) ? readFileSync(args.path, 'utf8') : undefined;
  const fresh = existing !== undefined && statSync(args.path).mtimeMs >= args.since;
  if (fresh && missingHeadings(existing).length === 0) return 'agent';

  const [commits, status] = await Promise.all([
    git(args.projectRoot, [
      'log',
      '--oneline',
      '-n',
      '20',
      ...(args.sinceHead ? [`${args.sinceHead}..HEAD`] : []),
    ]),
    git(args.projectRoot, ['status', '--short', '--', '.', `:(exclude)${relative(args.projectRoot, dirname(args.path))}`]),
  ]);

  const lastWords = args.agentText.trim().slice(-MAX_QUOTED_CHARS);
  const document = [
    `# Handoff: ${args.taskId}`,
    ``,
    args.cutShortBy === 'park'
      ? `Written by Ralph: the run was parked before the agent left a complete handoff,`
      : args.cutShortBy === 'early-stop'
        ? `Written by Ralph: the agent ended its turn before finishing the task, without leaving a complete handoff,`
        : `Written by Ralph: the agent ran out of ${args.cutShortBy ?? 'time'} without leaving a complete handoff,`,
    `so this records what the loop could see.`,
    ``,
    `## Status`,
    ``,
    `Iteration ${args.iteration} did not finish the task: ${args.reason}.`,
    ``,
    `## Done`,
    ``,
    commits ? `Commits made during the iteration:\n\n${fence(commits)}` : 'No commits during the iteration.',
    ``,
    `## Working tree`,
    ``,
    status ? `Uncommitted changes when it stopped:\n\n${fence(status)}` : 'Clean.',
    ``,
    `## Next steps`,
    ``,
    `Read the agent's last messages below and any uncommitted changes, decide what is worth`,
    `keeping, then continue the task.`,
    ...(args.cutShortBy === 'early-stop' ? [``, EARLY_STOP_ADVICE] : []),
    ...(args.cutShortBy === 'context' ? [``, CONTEXT_ADVICE] : []),
    ``,
    `## Dead ends`,
    ``,
    `Not recorded.`,
    ``,
    `## How to verify`,
    ``,
    `Follow the task spec.`,
    ...(lastWords ? [``, `## The agent's last messages`, ``, quote(lastWords)] : []),
    ...(existing?.trim()
      ? [``, fresh ? `## The agent's incomplete handoff` : `## An earlier handoff`, ``, quote(existing.trim().slice(0, MAX_QUOTED_CHARS))]
      : []),
    ``,
  ].join('\n');

  mkdirSync(dirname(args.path), { recursive: true });
  writeFileSync(args.path, document);
  return 'fallback';
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd });
    return stdout.trimEnd();
  } catch {
    return '';
  }
}

function fence(text: string): string {
  return ['```', text, '```'].join('\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}
