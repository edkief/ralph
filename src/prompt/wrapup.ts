import { HANDOFF_HEADINGS } from '../loop/handoff.js';

/** What ended the working time: the budget, a quiet agent, or a person parking the run. */
export type WrapUpTrigger = 'iteration-timeout' | 'inactivity' | 'park';

/**
 * The message that ends an iteration's working time. It asks the agent to
 * stop and hand off rather than to finish: a task that did not fit in the
 * whole budget will not fit in the wrap-up, and rushing it invites a task
 * marked as passing that does not.
 */
export function buildWrapUpPrompt(args: {
  taskId: string;
  /** Relative to the project root. */
  handoffPath: string;
  trigger: WrapUpTrigger;
  wrapUpMs: number;
}): string {
  const minutes = Math.max(1, Math.round(args.wrapUpMs / 60_000));
  const reason =
    args.trigger === 'inactivity'
      ? 'Your last step produced no output for too long and was interrupted. Do not run that command again as it was.'
      : args.trigger === 'park'
        ? 'The run is being parked: the work carries on later, maybe on another machine, from the repository alone.'
        : 'This iteration has used its working time.';

  return [
    args.trigger === 'park' ? `## Parking — hand off ${args.taskId}` : `## Time is up — hand off ${args.taskId}`,
    ``,
    `${reason} You have about ${minutes} minute${minutes === 1 ? '' : 's'} to hand off, then this session ends.`,
    ``,
    `1. Stop. Do not start new work and do not try to finish the task.`,
    `2. Kill any background processes you started.`,
    `3. Write \`${args.handoffPath}\` for whoever picks up ${args.taskId} next. They start with no memory of`,
    `   this session, so be specific: files, functions, commands, error messages. Use exactly these headings:`,
    ``,
    ...HANDOFF_HEADINGS.map((heading) => `   ## ${heading}`),
    ``,
    `   Status is one or two sentences on where the task stands. Working tree says what is committed,`,
    `   what is not, and whether it builds. Dead ends lists what you tried that did not work.`,
    `4. Commit your changes and the handoff as \`wip(${args.taskId}): <state of the work>\`, even if tests fail.`,
    `5. Do not set \`passes: true\` and do not output \`<promise>${args.taskId}:DONE</promise>\` — the task is not done.`,
    `6. End without any promise tag: no \`BLOCKED\`, no \`DECIDE\`. Running out of time is not being blocked;`,
    `   the next iteration resumes from your handoff. Put any question for a person under Next steps.`,
    ...(args.trigger === 'inactivity'
      ? [
          `   The one exception: if the step hung because of an environment problem you cannot fix from here`,
          `   (a service that is down, no network, missing credentials), end with \`<promise>BLOCKED:reason</promise>\`.`,
        ]
      : []),
    ``,
    `Then stop.`,
  ].join('\n');
}
