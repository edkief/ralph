import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer, type ScriptedEvent } from './helpers/fake-server.js';
import { OpencodeClient } from '../src/opencode/client.js';
import { runLoop } from '../src/loop/orchestrator.js';
import { ConsoleReporter } from '../src/report/console.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { Logger } from '../src/report/logger.js';

const sink = { write: () => true } as NodeJS.WriteStream;
const logger = new Logger({ level: 'error', stream: sink });
const reporter = new ConsoleReporter(sink, false);

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A throwaway git project with the .agent layout Ralph expects. */
function project(tasks: Array<{ id: string; passes: boolean }>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-loop-'));
  mkdirSync(resolve(root, '.agent'), { recursive: true });
  writeFileSync(resolve(root, '.agent/PROMPT.md'), 'Do one task.');
  writeFileSync(resolve(root, '.agent/tasks.json'), JSON.stringify(tasks));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

function markPassing(root: string, taskId: string): void {
  const file = resolve(root, '.agent/tasks.json');
  const tasks = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string; passes: boolean }>;
  for (const task of tasks) if (task.id === taskId) task.passes = true;
  writeFileSync(file, JSON.stringify(tasks));
}

function config(root: string, overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    projectRoot: root,
    pauseBetweenIterationsMs: 0,
    retries: { backoffMs: 0, iterationRetries: 0 },
    ...overrides,
  });
}

async function loop(root: string, cfg: Config, options: Parameters<typeof startFakeServer>[0]) {
  server = await startFakeServer(options);
  const client = new OpencodeClient({ baseUrl: server.url });
  return runLoop({ config: cfg, client, logger, reporter, signal: new AbortController().signal });
}

const say = (text: string): ScriptedEvent[] => [
  { type: 'session.text.ended', data: { text } },
  { type: 'session.execution.succeeded' },
];

describe('runLoop', () => {
  it('works through the backlog and stops when every task passes', async () => {
    const root = project([
      { id: 'TASK-1', passes: false },
      { id: 'TASK-2', passes: false },
    ]);

    const result = await loop(root, config(root, { maxIterations: 5 }), {
      onPrompt: (count) => markPassing(root, `TASK-${count}`),
      script: (count) => say(`<promise>TASK-${count}:DONE</promise>`),
    });

    expect(result.status).toBe('complete');
    expect(result.tasksPassed).toBe(2);
    expect(result.iterations).toBe(2);
  });

  it('pins each iteration to the next outstanding task', async () => {
    const root = project([
      { id: 'TASK-1', passes: true },
      { id: 'TASK-7', passes: false },
    ]);

    await loop(root, config(root, { maxIterations: 1 }), { script: say('working') });

    expect(String(server?.prompts[0]?.['text'])).toContain('TASK-7');
  });

  it('reports completion when the final iteration empties the backlog', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);

    const result = await loop(root, config(root, { maxIterations: 1 }), {
      onPrompt: () => markPassing(root, 'TASK-1'),
      script: say('<promise>TASK-1:DONE</promise>'),
    });

    expect(result.status).toBe('complete');
    expect(result.tasksPassed).toBe(1);
  });

  it('stops after repeated iterations that change nothing', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);

    const result = await loop(
      root,
      config(root, { maxIterations: 10, stall: { maxUnproductiveIterations: 3 } }),
      { script: say('I looked around and did nothing.') },
    );

    expect(result.status).toBe('stalled');
    expect(result.iterations).toBe(3);
    expect(result.message).toMatch(/changed nothing/);
  });

  it('counts a claimed task as progress only when the file agrees', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);

    const result = await loop(
      root,
      config(root, { maxIterations: 2, stall: { maxUnproductiveIterations: 2 } }),
      { script: say('<promise>TASK-1:DONE</promise>') },
    );

    expect(result.status).toBe('stalled');
    expect(result.tasksPassed).toBe(0);
  });

  it('treats a commit as progress even without a task flip', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);

    const result = await loop(root, config(root, { maxIterations: 2 }), {
      onPrompt: () => {
        writeFileSync(resolve(root, 'work.txt'), 'progress');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'feat: work'], { cwd: root });
      },
      script: say('committed'),
    });

    expect(result.status).toBe('max-iterations');
    expect(result.iterations).toBe(2);
  });

  it('stops immediately when the agent is blocked', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);

    const result = await loop(root, config(root, { maxIterations: 9 }), {
      script: say('<promise>BLOCKED:no API key</promise>'),
    });

    expect(result.status).toBe('blocked');
    expect(result.message).toBe('no API key');
    expect(result.iterations).toBe(1);
  });

  it('stops when the agent needs a decision', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);
    const result = await loop(root, config(root, { maxIterations: 9 }), {
      script: say('<promise>DECIDE:REST or GraphQL?</promise>'),
    });

    expect(result.status).toBe('decide');
    expect(result.message).toBe('REST or GraphQL?');
  });

  it('writes per-iteration history for debugging', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);
    const result = await loop(root, config(root, { maxIterations: 1 }), { script: say('hi') });

    expect(existsSync(resolve(result.historyDir, 'iterations.jsonl'))).toBe(true);
    expect(existsSync(resolve(result.historyDir, 'run.json'))).toBe(true);
    const events = readFileSync(
      resolve(result.historyDir, 'iteration-001.events.jsonl'),
      'utf8',
    );
    expect(events).toContain('session.text.ended');
  });

  it('exhausts the budget when work continues past it', async () => {
    const root = project([
      { id: 'TASK-1', passes: false },
      { id: 'TASK-2', passes: false },
      { id: 'TASK-3', passes: false },
    ]);

    const result = await loop(root, config(root, { maxIterations: 2 }), {
      onPrompt: (count) => markPassing(root, `TASK-${count}`),
      script: (count) => say(`<promise>TASK-${count}:DONE</promise>`),
    });

    expect(result.status).toBe('max-iterations');
    expect(result.tasksPassed).toBe(2);
  });
});
