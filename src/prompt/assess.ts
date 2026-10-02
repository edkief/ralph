/**
 * The message for a triage turn: before a task is attempted, the agent is
 * asked how much working time it needs, so that one too big for an iteration
 * is split first. The turn plans and estimates; it does none of the work.
 */
export function buildAssessPrompt(args: {
  projectRoot: string;
  taskId: string;
  title: string;
  /** Relative to the project root, when the task has a spec. */
  specPath?: string;
  specText?: string;
  iterationMs: number;
  /** A task estimated over this is split. */
  thresholdMs: number;
  /** The working time this turn has. */
  timeoutMs: number;
}): string {
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

  return [
    `PROJECT_ROOT=${args.projectRoot}`,
    ``,
    `## Assess ${args.taskId}`,
    ``,
    `${args.taskId} (${args.title}) is the next task. Before it is attempted, estimate how much working`,
    `time it needs. An iteration has about ${minutes(args.iterationMs)} minutes and starts a fresh session with no memory of`,
    `earlier ones; a task estimated at more than ${minutes(args.thresholdMs)} minutes is split into smaller tasks first.`,
    `Your job is to plan and estimate, not to implement. You have ${minutes(args.timeoutMs)} minutes, after which this turn`,
    `is cut off.`,
    ``,
    `### What you have`,
    ``,
    args.specPath
      ? `The spec, \`${args.specPath}\`:\n\n${fence(args.specText ?? '')}`
      : `The task has no spec file; its title is all there is.`,
    ``,
    `### What to do`,
    ``,
    `1. Read the spec and the code it concerns: the files to change, their tests, what they depend on.`,
    `   Read only as much as the estimate needs.`,
    `2. Do not start on the task. Edit and create no files, run no builds, tests or installs, and try`,
    `   nothing out to see whether it works. If you catch yourself solving a problem, stop: note it as`,
    `   a risk and move on.`,
    `3. Sketch the plan in a few lines: the steps, the files each touches, how the result is checked.`,
    `4. Estimate the minutes an agent like you needs to do all of it in one session, tests and commit`,
    `   included. Judge from what you read: the number of files and acceptance criteria, how much is new`,
    `   rather than a change to what exists, how long the project's checks take, what is unclear.`,
    `5. End your reply with exactly one tag, then stop:`,
    ``,
    `   <promise>ESTIMATE:minutes:why, in one sentence</promise>`,
    ``,
    `   For example \`<promise>ESTIMATE:50:parser, printer and their tests are three separate changes</promise>\`.`,
  ].join('\n');
}

function fence(text: string): string {
  const body = text.trimEnd();
  const ticks = body.includes('```') ? '````' : '```';
  return [ticks, body, ticks].join('\n');
}
