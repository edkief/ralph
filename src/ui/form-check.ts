import type { FormField, FormValue } from './types.js';

/**
 * Checks on an answer to an opencode form, shared by the web app (before it
 * sends) and the UI server (before it hands the answer on). opencode checks it
 * again and has the last word; this only catches what a person can put right.
 * Free of Node imports, so the web app bundles it.
 */

export type FormAnswer = Record<string, FormValue>;

/** Whether `field` is shown, given the answer so far: not hidden, and every `when` holds. */
export function fieldVisible(field: FormField, answer: FormAnswer): boolean {
  if (field.hidden) return false;
  return (field.when ?? []).every((condition) => {
    const value = answer[condition.key];
    const equal = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value;
    return condition.op === 'eq' ? equal : !equal;
  });
}

/** Fields a person answers: shown, and not a link to follow elsewhere. */
export function answerableFields(fields: FormField[], answer: FormAnswer): FormField[] {
  return fields.filter((field) => field.type !== 'external' && fieldVisible(field, answer));
}

/** The answer with only the fields shown, and no empty values. */
export function cleanAnswer(fields: FormField[], answer: FormAnswer): FormAnswer {
  const clean: FormAnswer = {};
  for (const field of answerableFields(fields, answer)) {
    const value = answer[field.key];
    if (isEmpty(value)) continue;
    clean[field.key] = value!;
  }
  return clean;
}

/** What is wrong with `answer`, one line per problem; empty when it fits. */
export function checkFormAnswer(fields: FormField[], answer: FormAnswer): string[] {
  const problems: string[] = [];
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(answer)) {
    if (!known.has(key)) problems.push(`"${key}" is not a field of this form`);
  }
  for (const field of answerableFields(fields, answer)) {
    const name = field.title ?? field.key;
    const value = answer[field.key];
    if (isEmpty(value)) {
      if (field.required) problems.push(`${name} needs an answer`);
      continue;
    }
    const problem = checkValue(field, value!);
    if (problem) problems.push(`${name}: ${problem}`);
  }
  return problems;
}

function checkValue(field: FormField, value: FormValue): string | undefined {
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return 'expects text';
      if (field.options?.length && !field.custom && !field.options.some((option) => option.value === value)) {
        return 'pick one of the options';
      }
      if (field.minLength !== undefined && value.length < field.minLength) return `at least ${field.minLength} characters`;
      if (field.maxLength !== undefined && value.length > field.maxLength) return `at most ${field.maxLength} characters`;
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(value)) return `does not match ${field.pattern}`;
        } catch {
          // A pattern this side cannot read: opencode judges it.
        }
      }
      return undefined;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expects a number';
      if (field.type === 'integer' && !Number.isInteger(value)) return 'expects a whole number';
      if (typeof field.minimum === 'number' && value < field.minimum) return `at least ${field.minimum}`;
      if (typeof field.maximum === 'number' && value > field.maximum) return `at most ${field.maximum}`;
      return undefined;
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'expects yes or no';
    case 'multiselect': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return 'expects a list of options';
      if (!field.custom && value.some((entry) => !field.options.some((option) => option.value === entry))) {
        return 'pick from the options';
      }
      if (field.minItems !== undefined && value.length < field.minItems) return `pick at least ${field.minItems}`;
      if (field.maxItems !== undefined && value.length > field.maxItems) return `pick at most ${field.maxItems}`;
      return undefined;
    }
    case 'external':
      return undefined;
  }
}

function isEmpty(value: FormValue | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}
