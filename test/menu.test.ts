import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { startMenu } from '../src/report/menu.js';
import { RespondError, type AnswerInput, type PendingState } from '../src/human/request.js';
import { ConsoleReporter } from '../src/report/console.js';
import { Logger } from '../src/report/logger.js';

const settle = () => new Promise((resolveWait) => setTimeout(resolveWait, 10));

function pendingSplit(): PendingState {
  return {
    pending: {
      id: 'req-1',
      runId: 'run',
      kind: 'split',
      taskId: 'TASK-2',
      message: 'TASK-2 ran out of time twice',
      split: { dir: '.ralph/splits/TASK-2', reason: 'too big', tasks: [{ id: 'TASK-2a', title: 'First half', specPath: 'a.json' }] },
      waiting: true,
      createdAt: 'now',
    },
    waiting: true,
    answered: false,
    actions: ['approve', 'retry', 'repropose', 'stop'],
  };
}

function menu(options: { pending?: PendingState; idleMs?: number; answer?: (input: AnswerInput) => Promise<string> } = {}) {
  const input = Object.assign(new PassThrough(), { raw: [] as boolean[], setRawMode(mode: boolean) { this.raw.push(mode); } });
  const calls: string[] = [];
  const answers: AnswerInput[] = [];
  let screen = '';
  const close = startMenu({
    input,
    output: { write: (text: string) => (screen += text) },
    hold: () => calls.push('hold'),
    release: () => calls.push('release'),
    stopAfterIteration: () => calls.push('stop-after'),
    stopNow: () => calls.push('stop-now'),
    park: () => calls.push('park'),
    pending: () => options.pending,
    answer:
      options.answer ??
      (async (answer) => {
        answers.push(answer);
        return 'Ralph has the answer and carries on.';
      }),
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
  });
  const press = async (keys: string) => {
    for (const key of keys.split('|')) {
      input.write(key);
      await settle();
    }
  };
  return { input, calls, answers, press, close, screen: () => screen };
}

describe('the run menu', () => {
  it('opens on Enter, holding other output, and closes on Enter', async () => {
    const { calls, press, screen, input } = menu();
    expect(input.raw).toEqual([true]);
    await press('x');
    expect(calls).toEqual([]);

    await press('\r');
    expect(calls).toEqual(['hold']);
    expect(screen()).toContain('stop after the current iteration');
    expect(screen()).not.toContain('Waiting for you');

    await press('\r');
    expect(calls).toEqual(['hold', 'release']);
  });

  it('stops after the iteration on s and now on q', async () => {
    const first = menu();
    await first.press('\r|s');
    expect(first.calls).toEqual(['hold', 'release', 'stop-after']);

    const second = menu();
    await second.press('\r|q');
    expect(second.calls).toEqual(['hold', 'release', 'stop-now']);
  });

  it('parks on h', async () => {
    const { calls, press, screen } = menu();
    await press('\r');
    expect(screen()).toContain('park: hand off, commit and push');
    await press('h');
    expect(calls).toEqual(['hold', 'release', 'park']);
  });

  it('stops now on Ctrl-C, menu or not', async () => {
    const closed = menu();
    await closed.press('\x03');
    expect(closed.calls).toEqual(['stop-now']);

    const open = menu();
    await open.press('\r|\x03');
    expect(open.calls).toEqual(['hold', 'release', 'stop-now']);
  });

  it('offers what the loop is waiting on, and delivers the answer', async () => {
    const { answers, press, screen, calls } = menu({ pending: pendingSplit() });
    await press('\r');
    expect(screen()).toContain('Waiting for you: TASK-2 ran out of time twice');
    expect(screen()).toContain('TASK-2a  First half');
    expect(screen()).toContain('approve the proposed split');

    await press('a');
    expect(answers).toEqual([{ id: 'req-1', action: 'approve' }]);
    expect(screen()).toContain('Ralph has the answer');
    expect(calls).toEqual(['hold', 'release']);
  });

  it('takes a line of text for an action that has one', async () => {
    const { answers, press, screen } = menu({ pending: pendingSplit() });
    await press('\r|p|smaler|\x7f|\x7f|ler steps|\r');
    expect(screen()).toContain('What to change');
    expect(answers).toEqual([{ id: 'req-1', action: 'repropose', text: 'smaller steps' }]);

    const skipped = menu({ pending: pendingSplit() });
    await skipped.press('\r|t|\r');
    expect(skipped.answers).toEqual([{ id: 'req-1', action: 'retry' }]);
  });

  it('needs text for an answer, and a number of iterations to continue', async () => {
    const question: PendingState = {
      ...pendingSplit(),
      pending: { ...pendingSplit().pending, kind: 'decide', question: 'Which database?' },
      actions: ['answer', 'stop'],
    };
    const asked = menu({ pending: question });
    await asked.press('\r');
    expect(asked.screen()).toContain('Waiting for you: Which database?');
    await asked.press('w|\r');
    expect(asked.answers).toEqual([]);
    await asked.press('sqlite|\r');
    expect(asked.answers).toEqual([{ id: 'req-1', action: 'answer', text: 'sqlite' }]);

    const budget: PendingState = { ...pendingSplit(), pending: { ...pendingSplit().pending, kind: 'budget' }, actions: ['continue', 'stop'] };
    const more = menu({ pending: budget });
    await more.press('\r|c|25|\r');
    expect(more.answers).toEqual([{ id: 'req-1', action: 'continue', iterations: 25 }]);

    const wrong = menu({ pending: budget });
    await wrong.press('\r|c|lots|\r');
    expect(wrong.answers).toEqual([]);
    expect(wrong.screen()).toContain('not a number of iterations');
  });

  it('says why an answer was turned down', async () => {
    const { press, screen, calls } = menu({
      pending: pendingSplit(),
      answer: async () => {
        throw new RespondError('Already answered', 'conflict');
      },
    });
    await press('\r|a');
    expect(screen()).toContain('Already answered');
    expect(calls).toEqual(['hold', 'release']);
  });

  it('ignores escape sequences, and leaves on Escape', async () => {
    const { press, calls } = menu();
    await press('\r|\x1b[A');
    expect(calls).toEqual(['hold']);
    await press('\x1b');
    expect(calls).toEqual(['hold', 'release']);
  });

  it('closes by itself when left open', async () => {
    const { press, calls } = menu({ idleMs: 30 });
    await press('\r');
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    expect(calls).toEqual(['hold', 'release']);
  });

  it('gives the terminal back', async () => {
    const { press, close, input, calls } = menu();
    await press('\r');
    close();
    expect(input.raw).toEqual([true, false]);
    expect(calls).toEqual(['hold', 'release']);
    await press('\r');
    expect(calls).toEqual(['hold', 'release']);
  });
});

describe('held output', () => {
  it('keeps the reporter’s lines for later and drops the status line', () => {
    let out = '';
    const reporter = new ConsoleReporter({ write: (text: string) => (out += text), isTTY: true } as unknown as NodeJS.WriteStream, true);
    reporter.status('working');
    reporter.hold();
    out = '';
    reporter.status('still working');
    reporter.iterationStart(3, 10, 'TASK-1');
    expect(out).toBe('');
    reporter.release();
    expect(out).toContain('Iteration 3/10');
    expect(out).not.toContain('still working');
  });

  it('keeps the logger’s lines for later, but not from its sinks', () => {
    let out = '';
    const logger = new Logger({ level: 'info', stream: { write: (text: string) => ((out += text), true) } as NodeJS.WriteStream });
    const sunk: string[] = [];
    logger.addSink((entry) => sunk.push(entry.message));
    logger.hold();
    logger.warn('while the menu is open');
    expect(out).toBe('');
    expect(sunk).toEqual(['while the menu is open']);
    logger.release();
    expect(out).toContain('while the menu is open');
    logger.info('after');
    expect(out).toContain('after');
  });
});
