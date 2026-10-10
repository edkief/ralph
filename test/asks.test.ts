import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AskError,
  askProcessAlive,
  clearAsk,
  listAsks,
  readAsk,
  readAskAnswer,
  rejectAskAnswer,
  waitForAskAnswer,
  writeAsk,
  writeAskAnswer,
} from '../src/human/asks.js';
import { checkFormAnswer, cleanAnswer, fieldVisible } from '../src/ui/form-check.js';
import type { FormField } from '../src/ui/types.js';

const root = () => mkdtempSync(join(tmpdir(), 'ralph-asks-'));

const form = (id: string, createdAt = '2026-10-10T00:00:00.000Z') => ({
  id,
  kind: 'form' as const,
  origin: 'run' as const,
  runId: 'run-1',
  taskId: 'TASK-1',
  sessionID: 'ses_1',
  form: { title: 'Questions', source: 'question', fields: [{ key: 'a', type: 'string' as const }] },
  createdAt,
});

const answer = (id: string, extra: object) => ({ id, by: 'ui' as const, answeredAt: new Date().toISOString(), ...extra });

describe('asks', () => {
  it('lists asks oldest first, with the process that asked', () => {
    const ralphRoot = root();
    writeAsk(ralphRoot, form('frm_b', '2026-10-10T00:00:02.000Z'));
    writeAsk(ralphRoot, form('frm_a', '2026-10-10T00:00:01.000Z'));

    const asks = listAsks(ralphRoot);
    expect(asks.map((ask) => ask.id)).toEqual(['frm_a', 'frm_b']);
    expect(asks[0]?.pid).toBe(process.pid);
    expect(askProcessAlive(asks[0]!)).toBe(true);
  });

  it('takes the first answer only, and one that fits the kind', () => {
    const ralphRoot = root();
    writeAsk(ralphRoot, form('frm_1'));

    expect(() => writeAskAnswer(ralphRoot, answer('frm_1', { decision: 'once' }))).toThrow(AskError);
    writeAskAnswer(ralphRoot, answer('frm_1', { answer: { a: 'x' } }));
    expect(() => writeAskAnswer(ralphRoot, answer('frm_1', { answer: { a: 'y' } }))).toThrow('already answered');
    expect(readAskAnswer(ralphRoot, 'frm_1')?.answer).toEqual({ a: 'x' });
    expect(() => writeAskAnswer(ralphRoot, answer('frm_gone', { cancel: '' }))).toThrow('no longer asked');
  });

  it('turns an answer down with a reason, making way for another', () => {
    const ralphRoot = root();
    writeAsk(ralphRoot, form('frm_1'));
    writeAskAnswer(ralphRoot, answer('frm_1', { answer: { a: 'x' } }));

    rejectAskAnswer(ralphRoot, 'frm_1', 'a: too short');
    expect(readAsk(ralphRoot, 'frm_1')?.error).toBe('a: too short');
    expect(readAskAnswer(ralphRoot, 'frm_1')).toBeUndefined();
    writeAskAnswer(ralphRoot, answer('frm_1', { answer: { a: 'xyz' } }));

    clearAsk(ralphRoot, 'frm_1');
    expect(listAsks(ralphRoot)).toEqual([]);
  });

  it('refuses an id that is not a file name', () => {
    expect(() => readAsk(root(), '../pending')).toThrow(AskError);
  });

  it('waits for the answer, or gives up on abort', async () => {
    const ralphRoot = root();
    writeAsk(ralphRoot, form('frm_1'));
    const waited = waitForAskAnswer({ ralphRoot, id: 'frm_1', signal: new AbortController().signal, pollMs: 10 });
    setTimeout(() => writeAskAnswer(ralphRoot, answer('frm_1', { cancel: 'no' })), 30);
    expect((await waited)?.cancel).toBe('no');

    const aborted = new AbortController();
    const gone = waitForAskAnswer({ ralphRoot, id: 'frm_2', signal: aborted.signal, pollMs: 10 });
    aborted.abort();
    expect(await gone).toBeUndefined();
  });
});

describe('form answers', () => {
  const fields: FormField[] = [
    { key: 'stack', type: 'string', title: 'Stack', required: true, options: [{ value: 'node', label: 'Node' }] },
    { key: 'other', type: 'string', title: 'Other', custom: true, options: [{ value: 'a', label: 'A' }], when: [{ key: 'stack', op: 'eq', value: 'node' }] },
    { key: 'count', type: 'integer', title: 'Count', minimum: 1, maximum: 3 },
    { key: 'ok', type: 'boolean' },
    { key: 'tags', type: 'multiselect', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], maxItems: 1 },
    { key: 'login', type: 'external', url: 'https://example.com' },
    { key: 'secret', type: 'string', hidden: true },
  ];

  it('accepts an answer that fits', () => {
    expect(checkFormAnswer(fields, { stack: 'node', other: 'free text', count: 2, ok: true, tags: ['x'] })).toEqual([]);
  });

  it('says what does not fit', () => {
    expect(checkFormAnswer(fields, { count: 1.5, ok: 'yes', tags: ['x', 'y'], extra: 'z' })).toEqual([
      '"extra" is not a field of this form',
      'Stack needs an answer',
      'Count: expects a whole number',
      'ok: expects yes or no',
      'tags: pick at most 1',
    ]);
    expect(checkFormAnswer(fields, { stack: 'deno', count: 9 })).toEqual(['Stack: pick one of the options', 'Count: at most 3']);
  });

  it('shows a field only while its conditions hold', () => {
    const other = fields[1]!;
    expect(fieldVisible(other, { stack: 'node' })).toBe(true);
    expect(fieldVisible(other, {})).toBe(false);
    expect(fieldVisible({ ...other, when: [{ key: 'tags', op: 'neq', value: 'x' }] }, { tags: ['x'] })).toBe(false);
  });

  it('keeps only what is shown and filled in', () => {
    expect(cleanAnswer(fields, { stack: 'deno', other: 'kept only for node', tags: [], ok: false })).toEqual({ stack: 'deno', ok: false });
  });
});
