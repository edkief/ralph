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
import { loadConfig } from '../src/config/load.js';
import { Logger } from '../src/report/logger.js';

const sink = { write: () => true } as NodeJS.WriteStream;
const logger = new Logger({ level: 'error', stream: sink });
const reporter = new ConsoleReporter(sink, false);

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A throwaway git project with the .ralph layout Ralph expects. */
function project(tasks: Array<{ id: string; passes: boolean }>, dir = '.ralph'): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-loop-'));
  mkdirSync(resolve(root, dir), { recursive: true });
  writeFileSync(resolve(root, dir, 'PROMPT.md'), 'Do one task.');
  writeFileSync(resolve(root, dir, 'tasks.json'), JSON.stringify(tasks));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

function markPassing(root: string, taskId: string, dir = '.ralph'): void {
  const file = resolve(root, dir, 'tasks.json');
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

async function loop(
  root: string,
  cfg: Config,
  options: Parameters<typeof startFakeServer>[0],
  stop?: AbortSignal,
) {
  server = await startFakeServer(options);
  const client = new OpencodeClient({ baseUrl: server.url });
  return runLoop({
    config: cfg,
    client,
    logger,
    reporter,
    signal: new AbortController().signal,
    ...(stop ? { stop } : {}),
  });
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

  describe('pushing', () => {
    /** Attach a bare repository as `origin`, returning its path. */
    function withRemote(root: string): string {
      const remote = mkdtempSync(resolve(tmpdir(), 'ralph-remote-'));
      execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
      execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
      return remote;
    }

    const commitWork = (root: string) => (count: number) => {
      writeFileSync(resolve(root, `work-${count}.txt`), 'progress');
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', `feat: work ${count}`], { cwd: root });
    };

    /** The remote's HEAD commit, or null while nothing has been pushed. */
    const remoteHead = (remote: string): string | null => {
      try {
        return execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
          cwd: remote,
          encoding: 'utf8',
        }).trim();
      } catch {
        return null;
      }
    };
    const localHead = (root: string) =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    it('does not push by default', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const remote = withRemote(root);

      await loop(root, config(root, { maxIterations: 1 }), {
        onPrompt: commitWork(root),
        script: say('committed'),
      });

      expect(remoteHead(remote)).toBeNull();
    });

    it('pushes after each committing iteration', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const remote = withRemote(root);
      const pushedHeads: Array<string | null> = [];

      await loop(root, config(root, { maxIterations: 2, git: { push: 'iteration' } }), {
        onPrompt: (count) => {
          // Before the second commit, the first must already be on the remote.
          if (count === 2) pushedHeads.push(remoteHead(remote));
          commitWork(root)(count);
        },
        script: say('committed'),
      });

      expect(pushedHeads[0]).not.toBeNull();
      expect(remoteHead(remote)).toBe(localHead(root));
    });

    it('pushes once at the end of the run', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const remote = withRemote(root);
      let remoteDuringRun: string | null = null;

      await loop(root, config(root, { maxIterations: 2, git: { push: 'end' } }), {
        onPrompt: (count) => {
          if (count === 2) remoteDuringRun = remoteHead(remote);
          commitWork(root)(count);
        },
        script: say('committed'),
      });

      expect(remoteDuringRun).toBeNull();
      expect(remoteHead(remote)).toBe(localHead(root));
    });

    it('keeps running when a push fails', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);

      const result = await loop(
        root,
        config(root, { maxIterations: 2, git: { push: 'iteration', remote: 'nowhere' } }),
        { onPrompt: commitWork(root), script: say('committed') },
      );

      expect(result.status).toBe('max-iterations');
      expect(result.iterations).toBe(2);
    });
  });

  describe('stopping on request', () => {
    it('finishes the current iteration, then stops', async () => {
      const root = project([
        { id: 'TASK-1', passes: false },
        { id: 'TASK-2', passes: false },
      ]);
      const stop = new AbortController();

      const result = await loop(
        root,
        config(root, { maxIterations: 5 }),
        {
          onPrompt: (count) => {
            if (count === 1) stop.abort();
            markPassing(root, `TASK-${count}`);
          },
          script: (count) => say(`<promise>TASK-${count}:DONE</promise>`),
        },
        stop.signal,
      );

      expect(result.status).toBe('stopped');
      expect(result.iterations).toBe(1);
      expect(result.tasksPassed).toBe(1);
      expect(result.message).toBe('Stopped on request after 1 iteration');
      expect(server?.prompts).toHaveLength(1);
    });

    it('does not retry a timed-out iteration once a stop is requested', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const stop = new AbortController();

      const result = await loop(
        root,
        config(root, {
          maxIterations: 5,
          timeouts: { inactivityMs: 1_000, wrapUpMs: 0 },
          retries: { backoffMs: 0, iterationRetries: 2 },
        }),
        { onPrompt: () => stop.abort(), script: [] },
        stop.signal,
      );

      expect(result.status).toBe('stopped');
      expect(server?.prompts).toHaveLength(1);
    });

    it('lets a finished backlog win over the stop request', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const stop = new AbortController();

      const result = await loop(
        root,
        config(root, { maxIterations: 5 }),
        {
          onPrompt: () => {
            stop.abort();
            markPassing(root, 'TASK-1');
          },
          script: say('<promise>TASK-1:DONE</promise>'),
        },
        stop.signal,
      );

      expect(result.status).toBe('complete');
    });
  });

  describe('running out of time', () => {
    const handoff = (root: string) => resolve(root, '.ralph', 'handoff', 'TASK-1.md');
    const headings = ['Status', 'Done', 'Working tree', 'Next steps', 'Dead ends', 'How to verify'];
    // A working turn that would run far past every budget in these tests.
    const endless: ScriptedEvent[] = [{ after: 60_000, type: 'session.execution.succeeded' }];

    it('has the agent hand off, then resumes the task from its handoff', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);

      const result = await loop(
        root,
        config(root, { maxIterations: 3, timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 5_000 } }),
        {
          steer: true,
          onPrompt: (count) => {
            if (count === 2) {
              mkdirSync(resolve(root, '.ralph', 'handoff'), { recursive: true });
              writeFileSync(handoff(root), `${headings.map((h) => `## ${h}\n\n-`).join('\n\n')}\n\nParser half done.`);
            }
            if (count === 3) markPassing(root, 'TASK-1');
          },
          script: (count) => (count === 1 ? endless : say(count === 2 ? 'handed off' : '<promise>TASK-1:DONE</promise>')),
        },
      );

      expect(result.status).toBe('complete');
      expect(result.iterations).toBe(2);
      const [first, wrapUp, resumed] = (server?.prompts ?? []).map((prompt) => String(prompt['text']));
      expect(first).toContain('## Time');
      expect(wrapUp).toContain('`.ralph/handoff/TASK-1.md`');
      expect(resumed).toContain('## Resuming TASK-1');
      expect(resumed).toContain('Parser half done.');

      const records = readFileSync(resolve(result.historyDir, 'iterations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({ handoff: 'agent', result: { status: 'wrapped-up', wrapUp: { delivery: 'steer' } } });
    });

    it('writes the handoff itself when the agent does not, and stops a task that keeps running out of time', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);

      const result = await loop(
        root,
        config(root, {
          maxIterations: 5,
          timeouts: { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 1_000 },
          retries: { backoffMs: 0, iterationRetries: 0 },
          stall: { maxTimeoutsPerTask: 2, maxUnproductiveIterations: 5 },
        }),
        { steer: true, script: endless },
      );

      expect(result.status).toBe('stalled');
      expect(result.iterations).toBe(2);
      expect(result.message).toBe('TASK-1 ran out of time 2 times; split it into smaller tasks (handoff: .ralph/handoff/TASK-1.md)');
      expect(readFileSync(handoff(root), 'utf8')).toContain('Written by Ralph');
      // The second attempt was told about the first.
      expect(String(server?.prompts[2]?.['text'])).toContain('## Resuming TASK-1');
    });
  });

  describe('running out of context', () => {
    const handoff = (root: string) => resolve(root, '.ralph', 'handoff', 'TASK-1.md');
    const overflow: ScriptedEvent[] = [
      { type: 'session.text.ended', data: { text: 'Reading the whole parser.' } },
      {
        type: 'session.step.failed',
        data: { error: { type: 'unknown', message: 'prompt is too long: 140000 tokens > 131072 maximum' } },
      },
      { type: 'session.execution.failed' },
    ];

    it('retries in a fresh session that resumes from a handoff', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);

      const result = await loop(
        root,
        config(root, { maxIterations: 3, retries: { backoffMs: 0, iterationRetries: 1 } }),
        {
          onPrompt: (count) => {
            if (count === 2) markPassing(root, 'TASK-1');
          },
          script: (count) => (count === 1 ? overflow : say('<promise>TASK-1:DONE</promise>')),
        },
      );

      expect(result.status).toBe('complete');
      expect(result.iterations).toBe(1);
      expect(server?.sessionsCreated).toBe(2);
      const retry = String(server?.prompts[1]?.['text']);
      expect(retry).toContain('## Resuming TASK-1');
      expect(retry).toContain('ran out of context');
      expect(retry).toContain('prompt is too long');
      expect(retry).toContain("filled the model's context window");

      const records = readFileSync(resolve(result.historyDir, 'iterations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({ result: { status: 'progressed' } });
    });

    it('stops a task that keeps outgrowing the context window', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);

      const result = await loop(
        root,
        config(root, {
          maxIterations: 5,
          retries: { backoffMs: 0, iterationRetries: 1 },
          stall: { maxTimeoutsPerTask: 2, maxUnproductiveIterations: 5 },
        }),
        { script: overflow },
      );

      expect(result.status).toBe('stalled');
      expect(result.iterations).toBe(1);
      expect(result.message).toBe('TASK-1 ran out of context 2 times; split it into smaller tasks (handoff: .ralph/handoff/TASK-1.md)');
      expect(readFileSync(handoff(root), 'utf8')).toContain('Written by Ralph: the agent ran out of context');
    });
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

  it('still runs a legacy .agent/ project, found through config resolution', async () => {
    const root = project([{ id: 'TASK-1', passes: false }], '.agent');
    const warnings: string[] = [];
    const cfg = loadConfig({
      projectRoot: root,
      env: {},
      overrides: { maxIterations: 2, pauseBetweenIterationsMs: 0 },
      onWarning: (message) => warnings.push(message),
    });

    const result = await loop(root, cfg, {
      onPrompt: () => markPassing(root, 'TASK-1', '.agent'),
      script: say('<promise>TASK-1:DONE</promise>'),
    });

    expect(cfg.ralphDir).toBe('.agent');
    expect(warnings.join('\n')).toMatch(/deprecated/);
    expect(result.status).toBe('complete');
    expect(result.historyDir.startsWith(resolve(root, '.agent', 'history'))).toBe(true);
    expect(existsSync(resolve(root, '.ralph'))).toBe(false);
  });
});
