/**
 * Promise tags are how the agent talks back to the loop:
 *   <promise>COMPLETE</promise>
 *   <promise>TASK-12:DONE</promise>
 *   <promise>BLOCKED:reason</promise>
 *   <promise>DECIDE:question</promise>
 */
const COMPLETE = /<promise>\s*COMPLETE\s*<\/promise>/i;
const BLOCKED = /<promise>\s*BLOCKED:([^<]*)<\/promise>/i;
const DECIDE = /<promise>\s*DECIDE:([^<]*)<\/promise>/i;
const TASK_DONE = /<promise>\s*(TASK-[A-Za-z0-9._-]+)\s*:\s*DONE\s*<\/promise>/gi;

export interface PromiseTags {
  complete: boolean;
  blockedReason?: string;
  decideQuestion?: string;
  completedTaskIds: string[];
}

/** Extract every promise tag from the agent's assistant text. */
export function parsePromiseTags(text: string): PromiseTags {
  const blocked = BLOCKED.exec(text)?.[1]?.trim();
  const decide = DECIDE.exec(text)?.[1]?.trim();

  const taskIds: string[] = [];
  for (const match of text.matchAll(TASK_DONE)) {
    const id = match[1];
    if (id && !taskIds.includes(id)) taskIds.push(id);
  }

  return {
    complete: COMPLETE.test(text),
    ...(blocked ? { blockedReason: blocked } : {}),
    ...(decide ? { decideQuestion: decide } : {}),
    completedTaskIds: taskIds,
  };
}

export type IterationStatus =
  /** Agent finished a task and the repository agrees. */
  | 'progressed'
  /** Agent ran to completion but nothing changed on disk. */
  | 'no-progress'
  /** Agent says the whole backlog is done. */
  | 'complete'
  | 'blocked'
  | 'decide'
  /** Provider unreachable, rate limited, or retrying in a loop. */
  | 'provider-error'
  /** Hit the hard iteration timeout or went quiet. */
  | 'timeout'
  /** The execution itself failed server-side. */
  | 'failed'
  | 'interrupted';

/** Statuses that should stop the run rather than start another iteration. */
export const TERMINAL_STATUSES = new Set<IterationStatus>([
  'complete',
  'blocked',
  'decide',
  'interrupted',
]);
