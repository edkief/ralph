import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Task } from '../tasks/store.js';
import { formatClock } from '../report/time.js';

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
  sections.push(
    readFileSync(promptFile, 'utf8').replaceAll(
      RALPH_DIR_PLACEHOLDER,
      ralphDir === '' ? '.' : ralphDir.split(sep).join('/'),
    ),
  );
  return sections.join('\n\n');
}
