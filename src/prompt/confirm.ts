/**
 * The message that settles a task left marked passing by an attempt that was
 * cut short, or with a handoff that says it is not done. The two disagree, so
 * the agent is asked which is true: it checks, and either confirms the task
 * with its DONE tag or reopens it. It does not get to finish the task here.
 */
export function buildConfirmPrompt(args: {
  taskId: string;
  /** Relative to the project root. */
  specFilePath?: string | undefined;
  /** Relative to the project root. */
  handoffPath: string;
  /** Relative to the project root. */
  tasksPath: string;
  /** Why the task's state is in doubt, e.g. the attempt ran out of time. */
  reason: string;
  confirmMs: number;
}): string {
  const minutes = Math.max(1, Math.round(args.confirmMs / 60_000));
  const { taskId } = args;
  return [
    `## Is ${taskId} done?`,
    ``,
    `${taskId} is marked \`passes: true\` in \`${args.tasksPath}\`, but ${args.reason}. Before the run moves`,
    `on to the next task, settle which it is. You have about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    ``,
    `1. Do not implement anything. This turn only checks.`,
    `2. Check ${taskId} against ${args.specFilePath ? `its spec, \`${args.specFilePath}\`` : 'its spec'}: every acceptance criterion. Read`,
    `   \`${args.handoffPath}\` if it exists, and run the project's linter, type checker and tests.`,
    `3. If everything is done and passing: make sure the log entry is written, delete \`${args.handoffPath}\`,`,
    `   commit, then output \`<promise>${taskId}:DONE</promise>\`.`,
    `4. If anything is missing or failing: set \`passes: false\` for ${taskId}, write in \`${args.handoffPath}\``,
    `   what is left to do, commit as \`wip(${taskId}): <state of the work>\`, and end without any promise tag.`,
    `   The next iteration picks the task up from there.`,
    ``,
    `When in doubt, it is not done.`,
  ].join('\n');
}
