import { resolve } from 'node:path';

/**
 * A handoff is the note an agent leaves when an iteration runs out of time,
 * so the next attempt at the task resumes instead of starting over. It lives
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

export function handoffPath(projectRoot: string, ralphDir: string, taskId: string): string {
  return resolve(projectRoot, ralphDir, 'handoff', `${taskId}.md`);
}
