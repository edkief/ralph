import { HANDOFF_HEADINGS } from '../loop/handoff.js';

/**
 * The message that resumes an agent that ended its turn with working time
 * left, no promise tag and its task not done: typically to wait for a
 * background job, expecting to be woken when it lands. Under Ralph nothing
 * wakes it, so it is told so and asked to carry on.
 */
export function buildResumePrompt(args: {
  taskId: string;
  /** Relative to the project root. */
  handoffPath: string;
  /** Working time left in the iteration. */
  leftMs: number;
}): string {
  const minutes = Math.max(1, Math.round(args.leftMs / 60_000));
  return [
    `## Carry on with ${args.taskId}`,
    ``,
    `Your turn ended, but ${args.taskId} is not done: it is not marked passing and you gave no promise tag.`,
    `This session ends when your turn ends. Nothing resumes you when a background job finishes, and`,
    `the next session starts with no memory of this one.`,
    ``,
    `1. If you are waiting on a command, wait for it now: poll its output (with \`sleep\` between checks)`,
    `   or run it again in the foreground. Then act on the result.`,
    `2. Carry on and finish the task: tests passing, \`passes: true\`, log entry, commit,`,
    `   then \`<promise>${args.taskId}:DONE</promise>\`.`,
    ``,
    `You have about ${minutes} minute${minutes === 1 ? '' : 's'} of working time left.`,
    `If you truly cannot go further in this session, kill any background processes you started, write`,
    `\`${args.handoffPath}\` with these headings: ${HANDOFF_HEADINGS.join(', ')}. Commit it with your changes as`,
    `\`wip(${args.taskId}): <state of the work>\`, and end without a promise tag.`,
  ].join('\n');
}
