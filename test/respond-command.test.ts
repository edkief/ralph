import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRespond } from '../src/human/command.js';
import { readAnswer, readPending, writePending } from '../src/human/request.js';
import { ConsoleReporter } from '../src/report/console.js';
import { ConfigSchema } from '../src/config/schema.js';
import { ExitCode } from '../src/exit.js';

const RUN = '20261001-090000';

/** A project whose run asked a question and, when `waiting`, is still there for the answer. */
function project(waiting: boolean, kind: 'decide' | 'budget' = 'decide'): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-respond-'));
  const run = resolve(root, '.ralph', 'history', RUN);
  mkdirSync(run, { recursive: true });
  writeFileSync(resolve(run, 'state.json'), JSON.stringify({ runId: RUN, status: waiting ? 'waiting' : 'decide', pid: process.pid, hostname: hostname() }));
  writePending(resolve(root, '.ralph'), {
    id: `${RUN}-1`,
    runId: RUN,
    kind,
    taskId: kind === 'decide' ? 'TASK-3' : null,
    message: kind === 'decide' ? 'REST or GraphQL?' : 'Reached the 10 iteration budget with work outstanding',
    ...(kind === 'decide' ? { question: 'REST or GraphQL?' } : {}),
    waiting,
    createdAt: '2026-10-01T09:00:00.000Z',
  });
  return root;
}

async function run(root: string, action?: string, text = '', iterations?: number) {
  let out = '';
  const stream = { write: (chunk: string) => ((out += chunk), true) } as unknown as NodeJS.WriteStream;
  const code = await runRespond({
    config: ConfigSchema.parse({ projectRoot: root }),
    action,
    text,
    ...(iterations !== undefined ? { iterations } : {}),
    reporter: new ConsoleReporter(stream, false),
  });
  return { code, out };
}

describe('ralph respond', () => {
  it('shows what is asked and how to answer it', async () => {
    const { code, out } = await run(project(true));
    expect(code).toBe(ExitCode.Complete);
    expect(out).toContain('Ralph is waiting for an answer');
    expect(out).toContain('REST or GraphQL?');
    expect(out).toContain('ralph respond answer');
    expect(out).toContain('ralph respond stop');
  });

  it('hands the answer to the waiting loop', async () => {
    const root = project(true);
    const { code, out } = await run(root, 'answer', 'REST, as elsewhere');
    expect(code).toBe(ExitCode.Complete);
    expect(out).toContain('Ralph has the answer');
    expect(readAnswer(resolve(root, '.ralph'))).toMatchObject({ action: 'answer', text: 'REST, as elsewhere', by: 'cli' });
  });

  it('passes on how many iterations to add', async () => {
    const root = project(true, 'budget');
    expect((await run(root, 'continue', '', 5)).code).toBe(ExitCode.Complete);
    expect(readAnswer(resolve(root, '.ralph'))).toMatchObject({ action: 'continue', iterations: 5 });
  });

  it('keeps the answer for the next run when no loop waits', async () => {
    const root = project(false);
    expect((await run(root)).out).toContain('The last run stopped for a person');

    const { code, out } = await run(root, 'answer', 'REST');
    expect(code).toBe(ExitCode.Complete);
    expect(out).toContain('run ralph again');
    expect(readFileSync(resolve(root, '.ralph', 'decisions.jsonl'), 'utf8')).toContain('"answer":"REST"');
    expect(readPending(resolve(root, '.ralph'))).toBeUndefined();
  });

  it('refuses what does not fit', async () => {
    const root = project(true);
    expect((await run(root, 'answer')).out).toContain('An answer needs text');
    expect((await run(root, 'approve')).out).toContain('choose one of: answer, stop');
    const unknown = await run(root, 'shrug');
    expect(unknown.code).toBe(ExitCode.ConfigError);
    expect(unknown.out).toContain('Unknown action: shrug');
    expect(readAnswer(resolve(root, '.ralph'))).toBeUndefined();

    const empty = mkdtempSync(resolve(tmpdir(), 'ralph-respond-'));
    expect((await run(empty)).code).toBe(ExitCode.Complete);
    expect((await run(empty, 'stop')).code).toBe(ExitCode.ConfigError);
  });
});
