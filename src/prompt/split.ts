/**
 * The message for a split turn: a task ran out of time or context too often
 * to be finished in one iteration, or was estimated to before any attempt,
 * and the agent is asked to break what is
 * left of it into smaller tasks, or to say why that would not help.
 */
export function buildSplitPrompt(args: {
  projectRoot: string;
  taskId: string;
  title: string;
  /** Relative to the project root, when the task has a spec. */
  specPath?: string;
  specText?: string;
  /** Relative to the project root, when the task has a handoff. */
  handoffPath?: string;
  handoffText?: string;
  /** `git log --oneline` of the commits that mention the task. */
  commits: string;
  /** What each attempt ran out of, e.g. "time" or "context"; empty when a person asked for the split. */
  cutShort: string[];
  /** The estimate that had the task split before any attempt at it. */
  estimate?: { minutes: number; thresholdMinutes: number };
  iterationMs: number;
  /** Where the proposal goes, relative to the project root. */
  proposalDir: string;
  /** What the person who turned down an earlier proposal wants from this one. */
  note?: string;
  /** Offer the answer "attempt it again as it is". */
  allowRetry?: boolean;
}): string {
  const minutes = Math.max(1, Math.round(args.iterationMs / 60_000));
  const attempts = args.cutShort.length;
  const first = `${args.taskId}.1`;
  const second = `${args.taskId}.2`;

  return [
    `PROJECT_ROOT=${args.projectRoot}`,
    ``,
    `## Split ${args.taskId}`,
    ``,
    args.estimate
      ? `${args.taskId} (${args.title}) was assessed before any attempt at it and estimated at about ${args.estimate.minutes} minutes of\nwork, more than the ${args.estimate.thresholdMinutes} minutes a task may take.`
      : attempts > 0
        ? `${args.taskId} (${args.title}) was attempted ${attempts} time${attempts === 1 ? '' : 's'} and each attempt ran out of ${[...new Set(args.cutShort)].join(' or ')}\nbefore finishing it.`
        : `${args.taskId} (${args.title}) was judged too big to finish in one iteration.`,
    `An iteration has about ${minutes} minutes and starts a fresh session with no memory of earlier ones.`,
    `Your job is to plan, not to implement: break what is`,
    `left of ${args.taskId} into smaller tasks that each fit in one iteration, or explain why splitting`,
    `would not help.`,
    ``,
    `### What you have`,
    ``,
    args.specPath
      ? `The spec, \`${args.specPath}\`:\n\n${fence(args.specText ?? '')}`
      : `The task has no spec file; its title is all there is.`,
    ``,
    args.handoffPath
      ? `The handoff the last attempt left, \`${args.handoffPath}\`:\n\n${args.handoffText ?? ''}`
      : `No handoff was left.`,
    ``,
    args.commits
      ? `Commits that mention ${args.taskId} (read them with \`git show\`):\n\n${fence(args.commits)}`
      : `No commits mention ${args.taskId}.`,
    ``,
    ...(args.note?.trim()
      ? [
          `A person reviewed an earlier proposed split, turned it down and asks for this instead:`,
          ``,
          args.note.trim(),
          ``,
        ]
      : []),
    `### What to do`,
    ``,
    `1. Read the spec, the handoff, the commits and the code they touch. Change no code and run nothing`,
    `   that modifies the project.`,
    `2. Decide whether the task is too big. If the attempts failed for another reason, such as a command`,
    `   that hangs, a test suite that takes most of the budget, a broken environment or a missing`,
    `   dependency, do not split it: smaller tasks would fail the same way.`,
    `3. To split it, write one spec per new task in \`${args.proposalDir}/\`: \`${first}.json\`, \`${second}.json\``,
    `   and so on, numbered from 1 in the order they should be done. Use the same JSON shape as the spec`,
    `   above (\`id\`, \`title\`, \`category\`, \`description\`, \`steps\`, \`acceptanceCriteria\`, \`notes\`), and:`,
    `   - Cover only the work that is left: what is already committed stays done.`,
    `   - Together, cover every acceptance criterion of ${args.taskId} not yet met.`,
    `   - Make each spec stand on its own: name the files, commands and conventions that matter. Put what`,
    `     the handoff says is done, the state of the working tree and its dead ends in the notes of the`,
    `     first new task, which picks up where the last attempt stopped.`,
    `   - Each task must build only on the ones before it and end with passing tests and a commit.`,
    `   - At least two tasks, each clearly smaller than ${args.taskId}.`,
    `4. Write \`${args.proposalDir}/proposal.json\`:`,
    ``,
    fence(
      JSON.stringify(
        {
          task: args.taskId,
          splittable: true,
          reason: 'Why this split fits: what each task covers, in a sentence or two.',
          tasks: [
            { id: first, title: 'Short title of the first task' },
            { id: second, title: 'Short title of the second task' },
          ],
        },
        null,
        2,
      ),
      'json',
    ),
    ``,
    `   If splitting would not help, write \`{ "task": "${args.taskId}", "splittable": false, "reason": "…" }\``,
    `   instead, with the reason a person needs to unblock the task, and no specs.`,
    ...(args.allowRetry
      ? [
          ``,
          `   If neither is called for, because the attempts made real progress, what is left clearly fits in`,
          `   one more iteration and nothing needs a person, add \`"retry": true\` to that:`,
          `   \`{ "task": "${args.taskId}", "splittable": false, "retry": true, "reason": "…" }\`, the reason saying what`,
          `   is left. Ralph then attempts ${args.taskId} once more as it is, from its handoff. This is granted once:`,
          `   do not use it to put off a split the task needs.`,
        ]
      : []),
    ``,
    `Write only inside \`${args.proposalDir}/\`. Do not edit tasks.json, the spec or the handoff: Ralph applies`,
    `the split. Then stop.`,
  ].join('\n');
}

/** Sent back to the agent when its proposal does not pass Ralph's checks. */
export function buildSplitFixPrompt(proposalDir: string, problems: string[]): string {
  return [
    `Ralph checked the proposal in \`${proposalDir}/\` and found these problems:`,
    ``,
    ...problems.map((problem) => `- ${problem}`),
    ``,
    `Fix them in the files, then stop.`,
  ].join('\n');
}

function fence(text: string, language = ''): string {
  const body = text.trimEnd();
  const ticks = body.includes('```') ? '````' : '```';
  return [`${ticks}${language}`, body, ticks].join('\n');
}
