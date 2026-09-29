import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Task } from '../tasks/store.js';

export interface PromptContext {
  projectRoot: string;
  ralphDir: string;
  iteration: number;
  maxIterations: number;
  nextTask?: Task | undefined;
  pinTask: boolean;
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

  const ralphDir = relative(context.projectRoot, resolve(context.projectRoot, context.ralphDir));
  sections.push(
    readFileSync(promptFile, 'utf8').replaceAll(
      RALPH_DIR_PLACEHOLDER,
      ralphDir === '' ? '.' : ralphDir.split(sep).join('/'),
    ),
  );
  return sections.join('\n\n');
}
