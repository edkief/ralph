import { FORM_DECLINED_MESSAGE, type AskRelay, type FormOutcome } from '../loop/asks.js';
import { checkFormAnswer, fieldVisible, type FormAnswer } from '../ui/form-check.js';
import type { PermissionDecisionReply } from '../human/asks.js';
import type { FormField, FormValue } from '../ui/types.js';
import type { InterviewIO } from './interview.js';

/** Typed at any field to decline the form. */
export const SKIP_COMMAND = '/skip';

/**
 * Forms and asked permissions put to the owner in the terminal of `ralph
 * init`, one field at a time, through the interview's own IO. One ask at a
 * time: a second waits for the first.
 */
export function terminalAskRelay(io: InterviewIO): AskRelay {
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const ask = async (prompt: string, signal: AbortSignal): Promise<string | null | undefined> => {
    if (signal.aborted) return undefined;
    return Promise.race([
      io.ask(prompt),
      new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ]);
  };

  return {
    form: (form, signal) =>
      inTurn(async (): Promise<FormOutcome | undefined> => {
        io.note(`The agent asks: ${form.title}. Answer each question (${SKIP_COMMAND} to decline).`);
        for (;;) {
          const answer: FormAnswer = {};
          for (const field of form.fields) {
            if (!fieldVisible(field, answer)) continue;
            if (field.type === 'external') {
              io.note(`${label(field)}: open ${field.url}`);
              const done = await ask('Press Enter once done', signal);
              if (done === undefined) return undefined;
              if (done === null || done.trim() === SKIP_COMMAND) return { cancel: FORM_DECLINED_MESSAGE };
              continue;
            }
            if (field.description) io.note(field.description);
            const options = 'options' in field ? (field.options ?? []) : [];
            if (options.length > 0) io.note(options.map((option, index) => `  ${index + 1}. ${option.label}${option.description ? ` · ${option.description}` : ''}`).join('\n'));
            for (;;) {
              const text = await ask(fieldPrompt(field), signal);
              if (text === undefined) return undefined;
              if (text === null || text.trim() === SKIP_COMMAND) return { cancel: FORM_DECLINED_MESSAGE };
              const parsed = parseFieldInput(field, text);
              if ('error' in parsed) {
                io.note(parsed.error);
                continue;
              }
              if (parsed.value !== undefined) answer[field.key] = parsed.value;
              break;
            }
          }
          const problems = checkFormAnswer(form.fields, answer);
          if (problems.length === 0) return { answer };
          io.note(`That does not fit: ${problems.join('; ')}. Once more:`);
        }
      }),
    permission: (request, signal) =>
      inTurn(async (): Promise<PermissionDecisionReply | undefined> => {
        io.note(`The agent asks to ${request.action}${request.resources.length ? `: ${request.resources.join(', ')}` : ''}${request.message ? `\n${request.message}` : ''}`);
        for (;;) {
          const text = await ask('Allow it? [o]nce, [a]lways or [r]eject', signal);
          if (text === undefined) return undefined;
          if (text === null) return 'reject';
          const decision = parseDecision(text);
          if (decision) return decision;
        }
      }),
    rejected: (_id, error) => io.note(`opencode did not take that answer: ${error}`),
    settled: () => {},
  };
}

function label(field: FormField): string {
  return field.title ?? field.key;
}

function fieldPrompt(field: FormField): string {
  const name = label(field);
  const optional = field.required ? '' : ' (optional)';
  const fallback = 'default' in field && field.default !== undefined ? ` [${String(field.default)}]` : '';
  switch (field.type) {
    case 'boolean':
      return `${name}? y/n${fallback}${optional}`;
    case 'multiselect':
      return `${name} (numbers, comma-separated)${fallback}${optional}`;
    default:
      return `${name}${field.type === 'string' && field.options?.length ? ' (number or text)' : ''}${fallback}${optional}`;
  }
}

/**
 * Read what was typed for `field`: nothing typed takes the default, or leaves
 * the field out; options are picked by number, value or label.
 */
export function parseFieldInput(field: FormField, input: string): { value: FormValue | undefined } | { error: string } {
  const text = input.trim();
  if (text === '') {
    const fallback = 'default' in field ? field.default : undefined;
    return { value: fallback };
  }
  switch (field.type) {
    case 'string': {
      if (!field.options?.length) return { value: text };
      const picked = pick(field.options, text);
      if (picked !== undefined) return { value: picked };
      return field.custom ? { value: text } : { error: `Pick 1 to ${field.options.length}` };
    }
    case 'number':
    case 'integer': {
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: 'A number, please' };
      if (field.type === 'integer' && !Number.isInteger(value)) return { error: 'A whole number, please' };
      return { value };
    }
    case 'boolean':
      if (/^(y|yes|true)$/i.test(text)) return { value: true };
      if (/^(n|no|false)$/i.test(text)) return { value: false };
      return { error: 'y or n, please' };
    case 'multiselect': {
      const values: string[] = [];
      for (const part of text.split(',').map((entry) => entry.trim()).filter(Boolean)) {
        const picked = pick(field.options, part);
        if (picked !== undefined) values.push(picked);
        else if (field.custom) values.push(part);
        else return { error: `"${part}" is not one of 1 to ${field.options.length}` };
      }
      return { value: [...new Set(values)] };
    }
    case 'external':
      return { value: undefined };
  }
}

function pick(options: Array<{ value: string; label: string }>, text: string): string | undefined {
  const index = /^\d+$/.test(text) ? Number(text) - 1 : -1;
  if (index >= 0 && index < options.length) return options[index]!.value;
  const lower = text.toLowerCase();
  return options.find((option) => option.value.toLowerCase() === lower || option.label.toLowerCase() === lower)?.value;
}

export function parseDecision(text: string): PermissionDecisionReply | undefined {
  const word = text.trim().toLowerCase();
  if (word === 'o' || word === 'once') return 'once';
  if (word === 'a' || word === 'always') return 'always';
  if (word === 'r' || word === 'reject' || word === 'n' || word === 'no') return 'reject';
  return undefined;
}
