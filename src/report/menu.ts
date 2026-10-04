import { RespondError, type Action, type AnswerInput, type PendingState } from '../human/request.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Closed again after this long without a key, so held output is not held for good. */
const IDLE_MS = 60_000;

/** The actions a waiting loop takes from the menu, by key. `stop` is the menu's own `s` and `q`. */
const ACTION_KEYS: Partial<Record<Action, { key: string; label: string; text?: string }>> = {
  approve: { key: 'a', label: 'approve the proposed split and carry on' },
  retry: { key: 't', label: 'try the task again without splitting it', text: 'Note for the agent (Enter for none)' },
  repropose: { key: 'p', label: 'have the agent propose another split', text: 'What to change (Enter for nothing)' },
  answer: { key: 'w', label: 'write an answer', text: 'Answer' },
  resume: { key: 'c', label: 'carry on', text: 'Note for the agent (Enter for none)' },
  continue: { key: 'c', label: 'carry on for more iterations', text: 'How many (Enter for the configured budget)' },
};

export interface MenuOptions {
  /** A terminal's input; put in raw mode while the menu listens. */
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => unknown };
  output: { write(text: string): unknown };
  /** Keep other output off the terminal while the menu is open, and let it through after. */
  hold(): void;
  release(): void;
  stopAfterIteration(): void;
  stopNow(): void;
  /** Hand the project over: the agent hands off, then the work is committed and pushed. */
  park?(): void;
  /** What the loop is asking a person, if it is. */
  pending(): PendingState | undefined;
  /** Hand the loop an answer; resolves to what to tell the person. */
  answer(input: AnswerInput): Promise<string>;
  idleMs?: number;
}

/**
 * The run's controls at a terminal. Enter opens a menu to stop the run, after
 * the current iteration, now or parked, and to answer what the loop is waiting on;
 * Ctrl-C stops now, menu or not. The terminal is in raw mode meanwhile, so
 * Ctrl-C arrives here as a key rather than as a signal to Ralph and the
 * opencode server both.
 *
 * Returns a function that gives the terminal back.
 */
export function startMenu(options: MenuOptions): () => void {
  const { input, output } = options;
  const idleMs = options.idleMs ?? IDLE_MS;
  type State =
    | { at: 'closed' }
    | { at: 'open'; actions: Map<string, Action>; pending: PendingState | undefined }
    | { at: 'text'; action: Action; id: string; required: boolean; typed: string };
  let state: State = { at: 'closed' };
  let idle: NodeJS.Timeout | undefined;
  // Keys are handled in order, also while an answer is being delivered.
  let queue = Promise.resolve();

  const say = (text: string) => output.write(text);

  const close = (note?: string) => {
    clearTimeout(idle);
    if (state.at === 'closed') return;
    state = { at: 'closed' };
    say(note ? `\r\x1b[2K  ${note}\n\n` : '\r\x1b[2K\n');
    options.release();
  };

  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => close('carrying on'), idleMs);
    idle.unref();
  };

  const open = () => {
    options.hold();
    const pending = options.pending();
    const actions = new Map<string, Action>();
    const lines = [`${BOLD}ralph${RESET}`, '  s      stop after the current iteration', '  q      stop now'];
    if (options.park) lines.push('  h      park: hand off, commit and push, to carry on elsewhere');
    if (pending?.waiting) {
      lines.push('', `  Waiting for you: ${pending.pending.question ?? pending.pending.message}`);
      for (const task of pending.pending.split?.tasks ?? []) lines.push(`    ${task.id}  ${task.title}`);
      if (pending.pending.analysis) lines.push(`  The escalation agent passed this on: ${pending.pending.analysis}`);
      for (const action of pending.actions) {
        const entry = ACTION_KEYS[action];
        if (!entry) continue;
        actions.set(entry.key, action);
        lines.push(`  ${entry.key}      ${entry.label}`);
      }
    }
    lines.push('  Enter  carry on', '');
    say(`\n${lines.join('\n')}\n${DIM}›${RESET} `);
    state = { at: 'open', actions, pending };
    touch();
  };

  const deliver = async (answer: AnswerInput) => {
    try {
      close(await options.answer(answer));
    } catch (cause) {
      if (!(cause instanceof RespondError)) throw cause;
      close(cause.message);
    }
  };

  const key = async (char: string): Promise<void> => {
    if (char === '\x03') {
      close();
      return options.stopNow();
    }
    if (state.at === 'closed') {
      if (char === '\r' || char === '\n') open();
      return;
    }
    touch();

    if (state.at === 'open') {
      const action = state.actions.get(char.toLowerCase());
      if (char === 's' || char === 'S') {
        close();
        return options.stopAfterIteration();
      }
      if (char === 'q' || char === 'Q') {
        close();
        return options.stopNow();
      }
      if ((char === 'h' || char === 'H') && options.park) {
        close();
        return options.park();
      }
      if (action && state.pending) {
        const id = state.pending.pending.id;
        const prompt = ACTION_KEYS[action]?.text;
        if (!prompt) return deliver({ id, action });
        say(`\r\x1b[2K${prompt}: `);
        state = { at: 'text', action, id, required: action === 'answer', typed: '' };
        return;
      }
      if (char === '\r' || char === '\n' || char === '\x1b') close();
      return;
    }

    // Typing a line of text for the action picked.
    if (char === '\x1b') return close();
    if (char === '\x7f' || char === '\b') {
      if (state.typed.length === 0) return;
      state.typed = state.typed.slice(0, -1);
      say('\b \b');
      return;
    }
    if (char === '\r' || char === '\n') {
      const { action, id, required } = state;
      const text = state.typed.trim();
      if (!text && required) return;
      say('\n');
      if (action === 'continue') {
        const iterations = Number(text);
        if (text && (!Number.isInteger(iterations) || iterations < 1)) return close('That is not a number of iterations');
        return deliver({ id, action, ...(text ? { iterations } : {}) });
      }
      return deliver({ id, action, ...(text ? { text } : {}) });
    }
    if (char >= ' ') {
      state.typed += char;
      say(char);
    }
  };

  const onData = (chunk: Buffer | string) => {
    const text = chunk.toString();
    // An escape sequence (an arrow key, say) is one key, and none of ours.
    const chars = text.length > 1 && text.startsWith('\x1b') ? [] : [...text];
    for (const char of chars) {
      queue = queue.then(() => key(char)).catch(() => close('That did not work'));
    }
  };

  input.setRawMode?.(true);
  input.on('data', onData);
  input.resume();

  return () => {
    close();
    input.off('data', onData);
    input.setRawMode?.(false);
    input.pause();
  };
}
