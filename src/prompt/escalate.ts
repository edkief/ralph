import type { Action, RequestKind } from '../human/request.js';
import type { Decision } from '../human/decisions.js';

/**
 * The message for an escalation turn: the loop would ask a person, and a
 * second agent gets the request first. Its job is to settle it, with one of
 * the answers a person could give, and to pass it on only when a person
 * really is needed.
 */
export function buildEscalationPrompt(args: {
  projectRoot: string;
  kind: RequestKind;
  /** What stopped the run, as a person would be told. */
  message: string;
  /** The coding agent's question, for a `decide` request. */
  question?: string;
  /** The proposal to review, for a `split` request. Paths are relative to the project root. */
  split?: { dir: string; reason: string; tasks: Array<{ id: string; title: string; specPath: string }> };
  task?: { id: string; title: string; specPath?: string; specText?: string };
  /** Relative to the project root, when the task has a handoff. */
  handoffPath?: string;
  handoffText?: string;
  /** `git log --oneline` of the commits that mention the task. */
  commits?: string;
  /** The end of what the coding agent last wrote. */
  agentText?: string;
  decisions?: Decision[];
  /** The project's own guidance for this agent (ESCALATION.md), and where it is. */
  guidance?: { path: string; text: string };
  /** The answers on offer. */
  actions: Action[];
  /** Iterations a `continue` may add at most. */
  maxIterations: number;
  /** The working time this turn has. */
  timeoutMs: number;
}): string {
  const minutes = Math.max(1, Math.round(args.timeoutMs / 60_000));
  const about = args.task ? ` on ${args.task.id} (${args.task.title})` : '';

  return [
    `PROJECT_ROOT=${args.projectRoot}`,
    ``,
    `## Escalation: ${TITLES[args.kind]}`,
    ``,
    `Ralph runs a coding agent in a loop, one task per iteration. The run has stopped${about}, and`,
    `before anyone is asked you get to settle it. The goal is a run that goes on without a person:`,
    `**settle what you can, and pass on only what truly needs a person.** You have about ${minutes} minutes.`,
    ``,
    `### What happened`,
    ``,
    args.question ? `The coding agent asks:\n\n${quote(args.question)}` : quote(args.message),
    ``,
    ...(args.split
      ? [
          `The split agent proposes replacing ${args.task?.id ?? 'the task'} with these tasks, specs in \`${args.split.dir}/\`:`,
          ``,
          ...args.split.tasks.map((task) => `- ${task.id}: ${task.title} (\`${task.specPath}\`)`),
          ``,
          ...(args.split.reason.trim() ? [`Its reason: ${args.split.reason.trim()}`, ``] : []),
        ]
      : []),
    ...(args.agentText?.trim()
      ? [`The end of what the coding agent last wrote:`, ``, fence(args.agentText.trim()), ``]
      : []),
    `### What you have`,
    ``,
    args.task
      ? args.task.specPath
        ? `The task's spec, \`${args.task.specPath}\`:\n\n${fence(args.task.specText ?? '')}`
        : `The task has no spec file; its title is all there is.`
      : `The request is about the run, not one task: \`tasks.json\` in Ralph's folder has the backlog.`,
    ``,
    ...(args.handoffPath ? [`The handoff the last attempt left, \`${args.handoffPath}\`:`, ``, args.handoffText ?? '', ``] : []),
    ...(args.commits ? [`Commits that mention ${args.task?.id ?? 'the task'} (read them with \`git show\`):`, ``, fence(args.commits), ``] : []),
    ...(args.decisions && args.decisions.length > 0
      ? [
          `Decisions already made, latest last. Stay consistent with them:`,
          ``,
          ...args.decisions.map((decision) => {
            const on = decision.taskId ? `${decision.taskId}: ` : '';
            return `- ${on}${oneLine(decision.question ?? decision.kind)} → ${oneLine(decision.answer)}`;
          }),
          ``,
        ]
      : []),
    `The project's PRD, plan and steering notes are in Ralph's folder beside \`tasks.json\`; read what bears on`,
    `the request.`,
    ``,
    ...(args.guidance?.text.trim()
      ? [`### Project guidance`, ``, `From \`${args.guidance.path}\`; it overrides the defaults below where they disagree:`, ``, args.guidance.text.trim(), ``]
      : []),
    `### What to do`,
    ``,
    `1. Find out what is really going on. Check the claim yourself: run the failing command, read the code`,
    `   and the logs, look at the working tree. A coding agent often reports as a wall something it can`,
    `   get past.`,
    `2. ${GUIDANCE[args.kind]}`,
    `3. You may run commands and fix the environment: install a missing tool or dependency, start a`,
    `   service, correct a local setting. Do not change the project's code, tests or specs, and do not`,
    `   commit: what the code needs, tell the coding agent in your note, which it gets as a decision.`,
    `4. Decide. Prefer settling to passing on. Where the spec, PRD, plan, code and earlier decisions do`,
    `   not settle a choice, pick the simplest option that is easy to undo, and say why in a sentence.`,
    `   Pass it on only when a person really is needed: credentials, accounts or access you do not have,`,
    `   spending money, legal or security calls, or a product choice with nothing to go on and costly to`,
    `   get wrong.`,
    `5. End your reply with exactly one tag, then stop. To settle it, one of:`,
    ``,
    ...args.actions.map((action) => `   ${resolveTag(action, args.maxIterations)}\n     ${ACTIONS[action]}`),
    ``,
    `   The note is what the coding agent reads in every later prompt: make it concrete (what you found,`,
    `   what you fixed, what to do next).`,
    ``,
    `   To pass it on to a person:`,
    ``,
    `   <promise>ESCALATE:what the person needs to do, and what you found</promise>`,
  ].join('\n');
}

/** Sent back when the reply did not end with a tag Ralph can act on. */
export function buildEscalationFixPrompt(problem: string, actions: Action[]): string {
  return [
    `Ralph could not act on your reply: ${problem}.`,
    ``,
    `End with exactly one tag: \`<promise>RESOLVE:action:note</promise>\`, the action one of ${actions.join(', ')},`,
    `or \`<promise>ESCALATE:what the person needs to do</promise>\`. Then stop.`,
  ].join('\n');
}

const TITLES: Record<RequestKind, string> = {
  blocked: 'the coding agent is blocked',
  decide: 'the coding agent needs a decision',
  stalled: 'the run stalled',
  split: 'a proposed split to review',
  budget: 'the iteration budget is spent',
};

const GUIDANCE: Record<RequestKind, string> = {
  blocked:
    'The coding agent says it is blocked. If the blocker is real and you can remove it, do, then resume.\n   If it is not a blocker (the agent misread an error, gave up early, or the work can go another way),\n   resume with a note saying how to go on.',
  decide:
    'The coding agent wants a decision. Make it: weigh the options against the spec, the PRD, the code as\n   it is and the decisions already made, and answer with the choice and the reason.',
  stalled:
    'Iterations stopped getting anywhere. Work out why (a command that hangs, a wrong approach repeated,\n   a task that is unclear) and resume with a note that sends the next attempt down a path that works.',
  split:
    'Review the proposal. Approve it when the new tasks together cover what is left of the task, each fits\n   one iteration and builds only on the ones before. Ask for another proposal, saying what to change,\n   when it falls short; retry when the task is better attempted again as it is.',
  budget:
    'The run used its iterations with work outstanding. Look at what the last iterations achieved\n   (commits, tasks passing). If the work is moving, continue; if it is going round in circles, pass it on.',
};

const ACTIONS: Record<Action, string> = {
  approve: 'apply the proposed split and carry on',
  retry: 'attempt the task again as it is, without splitting it; the note is for the coding agent',
  repropose: 'have the split agent propose again; the note says what to change',
  answer: 'answer the question; the note is the answer, with its reason',
  resume: 'carry on; the note tells the coding agent what you found and what to do',
  continue: 'carry on for more iterations',
  stop: 'end the run',
  dismiss: 'close the request',
};

function resolveTag(action: Action, maxIterations: number): string {
  if (action === 'continue') return `<promise>RESOLVE:continue:iterations, at most ${maxIterations}:why</promise>`;
  return `<promise>RESOLVE:${action}:note</promise>`;
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function fence(text: string): string {
  const body = text.trimEnd();
  const ticks = body.includes('```') ? '````' : '```';
  return [ticks, body, ticks].join('\n');
}
