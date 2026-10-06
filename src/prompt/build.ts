import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Task } from '../tasks/store.js';
import type { SplitAncestor } from '../tasks/splits.js';
import { formatClock } from '../report/time.js';
import type { Decision } from '../human/decisions.js';

export interface PromptContext {
  projectRoot: string;
  ralphDir: string;
  iteration: number;
  maxIterations: number;
  nextTask?: Task | undefined;
  pinTask: boolean;
  /** Working time before the agent is asked to wrap up, and when it ends. */
  timeBudget?: { ms: number; until: Date };
  /** A handoff left by an earlier attempt at the next task. */
  handoff?: { path: string; text: string };
  /** The tasks the next task was split from, nearest first. */
  lineage?: SplitAncestor[];
  /** What a person or the escalation agent answered or noted, in this run and earlier ones, oldest first. */
  decisions?: Decision[];
}

export class PromptError extends Error {}

/** Written in PROMPT.md wherever it refers to Ralph's folder. */
export const RALPH_DIR_PLACEHOLDER = '{{RALPH_DIR}}';

/**
 * Compose the prompt for one iteration: the project's PROMPT.md plus the
 * loop's own framing. `{{RALPH_DIR}}` in PROMPT.md becomes the resolved
 * folder, relative to the project root, so the prompt follows the config.
 *
 * Pinning the task matters for smaller self-hosted models — "work on TASK-7"
 * is a far more reliable instruction than "pick the highest-priority task
 * with passes: false", which asks the model to re-derive selection logic the
 * loop already knows.
 */
export function buildPrompt(context: PromptContext): string {
  const promptFile = resolve(context.projectRoot, context.ralphDir, 'PROMPT.md');
  if (!existsSync(promptFile)) {
    throw new PromptError(`Prompt file not found: ${promptFile}`);
  }

  const sections = [
    `PROJECT_ROOT=${context.projectRoot}`,
    `RALPH_ITERATION=${context.iteration} of ${context.maxIterations}`,
  ];

  if (context.timeBudget) {
    const minutes = Math.round(context.timeBudget.ms / 60_000);
    sections.push(
      [
        `## Time`,
        ``,
        `You have about ${minutes} minutes, until ${formatClock(context.timeBudget.until)} (check with \`date\`).`,
        `When the time is up you will be asked to stop and hand off, so commit working checkpoints`,
        `as you go: anything committed survives.`,
      ].join('\n'),
    );
  }

  if (context.pinTask && context.nextTask) {
    sections.push(
      [
        `## Your task this iteration`,
        ``,
        `Work on **${context.nextTask.id}** — ${context.nextTask.title}`,
        context.nextTask.specFilePath
          ? `Full spec: \`${context.nextTask.specFilePath}\``
          : undefined,
        ``,
        `Do not pick a different task. Do not start a second task.`,
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    );
  }

  if (context.lineage && context.lineage.length > 0 && context.nextTask) {
    sections.push(splitSection(context.nextTask.id, context.lineage));
  }

  if (context.handoff && context.nextTask) {
    const path = relative(context.projectRoot, context.handoff.path).split(sep).join('/');
    sections.push(
      [
        `## Resuming ${context.nextTask.id}`,
        ``,
        `An earlier attempt at this task was cut short and left the handoff below (\`${path}\`).`,
        `Pick up from it instead of starting over, and check the working tree it describes.`,
        `Delete the handoff file in the commit that completes the task.`,
        ``,
        context.handoff.text,
      ].join('\n'),
    );
  }

  const ralphDir = relative(context.projectRoot, resolve(context.projectRoot, context.ralphDir));
  if (context.decisions && context.decisions.length > 0) {
    const log = [...(ralphDir === '' ? [] : ralphDir.split(sep)), 'decisions.jsonl'].join('/');
    sections.push(
      [
        `## Decisions`,
        ``,
        `A person, or the escalation agent in their place, answered these questions and left these notes,`,
        `latest last (\`${log}\`). They are decided: follow them where they apply, over the spec where the`,
        `two disagree, and do not ask again.`,
        ``,
        ...context.decisions.map((decision) => {
          const about = decision.taskId ? `${decision.taskId}: ` : '';
          const question = decision.question ? `${about}${oneLine(decision.question)}` : `${about}note`;
          const by = decision.by === 'agent' ? ' (escalation agent)' : '';
          return `- ${question}${by}\n  **${decision.answer.trim().split('\n').join('\n  ')}**`;
        }),
      ].join('\n'),
    );
  }

  sections.push(
    readFileSync(promptFile, 'utf8').replaceAll(
      RALPH_DIR_PLACEHOLDER,
      ralphDir === '' ? '.' : ralphDir.split(sep).join('/'),
    ),
  );
  return sections.join('\n\n');
}

/**
 * Where a task made by a split came from: the scope of the task it replaced,
 * what the last attempt at that one left, and the tasks that share the rest.
 */
function splitSection(taskId: string, lineage: SplitAncestor[]): string {
  const [parent] = lineage as [SplitAncestor, ...SplitAncestor[]];
  const lines = [
    `## Split from ${parent.id}`,
    ``,
    `${taskId} is part of ${name(parent)}, which was split into smaller tasks when it was too big for one`,
    `iteration. Read what it was for context: its full scope, and the work already done on it,`,
    `which stays done.`,
  ];
  lineage.forEach((ancestor, index) => {
    const mine = index === 0 ? taskId : lineage[index - 1]!.id;
    lines.push(``, index === 0 ? `${name(ancestor)}:` : `${name(lineage[index - 1]!)} was itself split from ${name(ancestor)}:`, ``);
    if (ancestor.specFilePath) lines.push(`- Its spec, the whole of what it asked for: \`${ancestor.specFilePath}\``);
    if (ancestor.handoffPath) lines.push(`- Where its last attempt stopped: \`${ancestor.handoffPath}\``);
    lines.push(`- Commits that mention ${ancestor.id}: \`git log --grep=${ancestor.id}\``);
    lines.push(`- What it was split into, in order:`);
    for (const child of ancestor.children) {
      const state = child.id === mine ? '▶' : child.passes ? '✓' : '○';
      const note = child.id === taskId ? ' (this task)' : child.id === mine ? ` (which ${taskId} is part of)` : child.passes === null ? ' (split again)' : '';
      lines.push(`  ${state} ${child.id} — ${child.title}${note}`);
    }
  });
  lines.push(
    ``,
    `Do only ${taskId}. What ${parent.id} asks beyond it belongs to the other tasks it was split into: leave`,
    `that to them.`,
  );
  return lines.join('\n');
}

function name(ancestor: SplitAncestor): string {
  return ancestor.title ? `${ancestor.id} (${ancestor.title})` : ancestor.id;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
