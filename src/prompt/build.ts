import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../tasks/store.js';

export interface PromptContext {
  projectRoot: string;
  agentDir: string;
  iteration: number;
  maxIterations: number;
  nextTask?: Task | undefined;
  pinTask: boolean;
}

export class PromptError extends Error {}

/**
 * Compose the prompt for one iteration: the project's PROMPT.md plus the
 * loop's own framing.
 *
 * Pinning the task matters for smaller self-hosted models — "work on TASK-7"
 * is a far more reliable instruction than "pick the highest-priority task
 * with passes: false", which asks the model to re-derive selection logic the
 * loop already knows.
 */
export function buildPrompt(context: PromptContext): string {
  const promptFile = resolve(context.projectRoot, context.agentDir, 'PROMPT.md');
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

  sections.push(readFileSync(promptFile, 'utf8'));
  return sections.join('\n\n');
}
