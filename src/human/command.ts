import { pendingState, respond } from './respond.js';
import { ACTIONS, RespondError, type Action } from './request.js';
import { ConsoleReporter } from '../report/console.js';
import { ExitCode } from '../exit.js';
import type { Config } from '../config/schema.js';

const HINTS: Record<Action, string> = {
  approve: 'apply the proposed split and carry on',
  retry: 'try the task again without splitting it; text is a note for the agent',
  repropose: 'have the agent propose another split; text says what to change',
  answer: 'answer the question; needs text',
  resume: 'carry on; text is a note for the agent',
  continue: 'carry on for more iterations (--iterations <n>)',
  stop: 'end the run as it would have ended without waiting',
  dismiss: 'close the request; text is kept as a note for the agent',
};

/**
 * `ralph respond [action] [text…]`: show what Ralph is asking a person, or
 * answer it, as the web UI does.
 *
 * Exit codes: 0 shown or answered, 4 nothing to answer or an answer that does
 * not fit.
 */
export async function runRespond(args: {
  config: Config;
  action: string | undefined;
  text: string;
  iterations?: number;
  reporter?: ConsoleReporter;
}): Promise<number> {
  const { config } = args;
  const reporter = args.reporter ?? new ConsoleReporter();
  const state = pendingState(config.projectRoot, config.ralphDir);

  if (!state) {
    reporter.summary('Nothing is waiting for an answer', [], args.action ? 'bad' : 'good');
    return args.action ? ExitCode.ConfigError : ExitCode.Complete;
  }
  const { pending, actions } = state;
  const usage = actions.map((action) => `ralph respond ${action}  — ${HINTS[action]}`);

  if (!args.action) {
    reporter.summary(
      state.waiting ? 'Ralph is waiting for an answer' : 'The last run stopped for a person',
      [
        pending.message,
        ...(pending.split
          ? ['', ...pending.split.tasks.map((task) => `${task.id}  ${task.title}`), '', `Specs and proposal: ${pending.split.dir}/`]
          : []),
        '',
        ...(state.answered ? ['Already answered; Ralph has not picked the answer up yet.'] : usage),
      ],
      'warn',
    );
    return ExitCode.Complete;
  }

  if (!(ACTIONS as readonly string[]).includes(args.action)) {
    reporter.summary(`Unknown action: ${args.action}`, usage, 'bad');
    return ExitCode.ConfigError;
  }

  try {
    const result = await respond({
      projectRoot: config.projectRoot,
      ralphDir: config.ralphDir,
      input: {
        id: pending.id,
        action: args.action as Action,
        ...(args.text.trim() ? { text: args.text.trim() } : {}),
        ...(args.iterations !== undefined ? { iterations: args.iterations } : {}),
      },
      by: 'cli',
      records: config.git.records,
    });
    reporter.summary(result.message, [], 'good');
    return ExitCode.Complete;
  } catch (cause) {
    if (!(cause instanceof RespondError)) throw cause;
    reporter.summary('Could not answer', [cause.message, '', ...usage], 'bad');
    return ExitCode.ConfigError;
  }
}
