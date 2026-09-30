import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer } from './helpers/fake-server.js';
import { runSplit } from '../src/split/command.js';
import { splitCheck } from '../src/opencode/preflight.js';
import { ConsoleReporter } from '../src/report/console.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { Logger } from '../src/report/logger.js';
import { ExitCode } from '../src/exit.js';

const sink = { write: () => true } as NodeJS.WriteStream;
const logger = new Logger({ level: 'error', stream: sink });

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const spec = (id: string) => JSON.stringify({ id, title: id, acceptanceCriteria: [`${id} works`] });

function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-split-cmd-'));
  mkdirSync(resolve(root, '.ralph', 'tasks'), { recursive: true });
  writeFileSync(resolve(root, '.ralph', 'tasks', 'TASK-1.json'), spec('TASK-1'));
  writeFileSync(
    resolve(root, '.ralph', 'tasks.json'),
    JSON.stringify([
      { id: 'TASK-1', title: 'Big', specFilePath: '.ralph/tasks/TASK-1.json', passes: false },
      { id: 'TASK-2', title: 'Done', passes: true },
    ]),
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'plan'], { cwd: root });
  return root;
}

function writeProposal(root: string, proposal: Record<string, unknown>, ids: string[] = []): void {
  const dir = resolve(root, '.ralph', 'split', 'TASK-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'proposal.json'), JSON.stringify({ task: 'TASK-1', ...proposal }));
  for (const id of ids) writeFileSync(resolve(dir, `${id}.json`), spec(id));
}
const split = { splittable: true, reason: 'Two halves.', tasks: [{ id: 'TASK-1.1', title: 'First half' }, { id: 'TASK-1.2', title: 'Second half' }] };

function config(root: string, url = 'http://127.0.0.1:9'): Config {
  return ConfigSchema.parse({ projectRoot: root, server: { url } });
}

/** Run the command, capturing what it prints. */
async function split_(root: string, taskId: string | undefined, apply = false, url?: string) {
  let out = '';
  const stream = { write: (chunk: string) => ((out += chunk), true) } as unknown as NodeJS.WriteStream;
  const code = await runSplit({ config: config(root, url), logger, taskId, apply, reporter: new ConsoleReporter(stream, false) });
  return { code, out };
}

const ids = (root: string) =>
  (JSON.parse(readFileSync(resolve(root, '.ralph', 'tasks.json'), 'utf8')) as Array<{ id: string }>).map((task) => task.id);

describe('ralph split', () => {
  it('has the agent propose a split, and only shows it', async () => {
    const root = project();
    server = await startFakeServer({
      onPrompt: () => writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']),
      script: [{ type: 'session.text.ended', data: { text: 'proposed' } }, { type: 'session.execution.succeeded' }],
    });

    const { code, out } = await split_(root, 'TASK-1', false, server.url);

    expect(code).toBe(ExitCode.Complete);
    expect(out).toContain('TASK-1.1  First half');
    expect(out).toContain('ralph split TASK-1 --apply');
    expect(String(server.prompts[0]?.['text'])).toContain('TASK-1 (Big) was judged too big');
    expect(ids(root)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('applies an existing proposal without asking the agent again', async () => {
    const root = project();
    writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);

    const { code, out } = await split_(root, 'TASK-1', true);

    expect(code).toBe(ExitCode.Complete);
    expect(out).toContain('Committed.');
    expect(ids(root)).toEqual(['TASK-1.1', 'TASK-1.2', 'TASK-2']);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' })).toContain(
      'chore(plan): split TASK-1 into TASK-1.1 and TASK-1.2',
    );

    const again = await split_(root, 'TASK-1', true);
    expect(again.code).toBe(ExitCode.Complete);
    expect(again.out).toContain('TASK-1 was already split');
  });

  it('reports advice against splitting', async () => {
    const root = project();
    writeProposal(root, { splittable: false, reason: 'the build hangs' });
    const { code, out } = await split_(root, 'TASK-1', true);
    expect(code).toBe(ExitCode.Stalled);
    expect(out).toContain('the build hangs');
    expect(ids(root)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('refuses a proposal with problems, a missing id, and a task that passes', async () => {
    const root = project();
    writeProposal(root, split, ['TASK-1.1']);
    const invalid = await split_(root, 'TASK-1', true);
    expect(invalid.code).toBe(ExitCode.ConfigError);
    expect(invalid.out).toContain('spec .ralph/split/TASK-1/TASK-1.2.json does not exist');

    expect((await split_(root, undefined)).code).toBe(ExitCode.ConfigError);
    expect((await split_(root, 'TASK-9')).out).toContain('TASK-9 is not in tasks.json');
    expect((await split_(root, 'TASK-2')).out).toContain('TASK-2 already passes');
  });
});

describe('splitCheck', () => {
  it('warns about a split proposed but not applied', async () => {
    const root = project();
    expect(splitCheck(config(root))).toBeUndefined();

    writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
    expect(splitCheck(config(root))).toMatchObject({ name: 'splits', ok: false, fatal: false });
    expect(splitCheck(config(root))?.detail).toContain('ralph split TASK-1 --apply');

    await split_(root, 'TASK-1', true);
    expect(splitCheck(config(root))).toBeUndefined();
  });

  it('says nothing about advice against splitting', () => {
    const root = project();
    writeProposal(root, { splittable: false, reason: 'hangs' });
    expect(splitCheck(config(root))).toBeUndefined();
  });
});
