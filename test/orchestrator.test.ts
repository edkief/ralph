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
import { respond } from '../src/human/respond.js';
import { readPending, requestStop, type AnswerInput } from '../src/human/request.js';

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

/** Run the loop so that it waits for a person, looking for answers often. */
async function waitingLoop(root: string, cfg: Config, options: Parameters<typeof startFakeServer>[0]) {
  server = await startFakeServer(options);
  return runLoop({
    config: { ...cfg, ui: { ...cfg.ui, wait: true } },
    client: new OpencodeClient({ baseUrl: server.url }),
    logger,
    reporter,
    signal: new AbortController().signal,
    pollMs: 10,
  });
}

/** Answer the loop's next request as a person would, once it waits; resolves with the request. */
async function answer(root: string, input: Omit<AnswerInput, 'id'>, after?: string) {
  const ralphRoot = resolve(root, '.ralph');
  for (;;) {
    const pending = readPending(ralphRoot);
    if (pending?.waiting && pending.id !== after) {
      try {
        await respond({ projectRoot: root, ralphDir: '.ralph', input: { id: pending.id, ...input }, by: 'ui' });
        return pending;
      } catch {
        // The loop has written the request but not yet said it waits.
      }
    }
    await new Promise((done) => setTimeout(done, 5));
  }
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
          stall: { maxTimeoutsPerTask: 2, maxUnproductiveIterations: 5, onRepeatedTimeout: 'stop' },
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
          stall: { maxTimeoutsPerTask: 2, maxUnproductiveIterations: 5, onRepeatedTimeout: 'stop' },
        }),
        { script: overflow },
      );

      expect(result.status).toBe('stalled');
      expect(result.iterations).toBe(1);
      expect(result.message).toBe('TASK-1 ran out of context 2 times; split it into smaller tasks (handoff: .ralph/handoff/TASK-1.md)');
      expect(readFileSync(handoff(root), 'utf8')).toContain('Written by Ralph: the agent ran out of context');
    });
  });

  describe('splitting a task that keeps running out of time', () => {
    const endless: ScriptedEvent[] = [{ after: 60_000, type: 'session.execution.succeeded' }];
    const spec = (id: string) => JSON.stringify({ id, title: id, acceptanceCriteria: [`${id} works`] });
    const timeouts = { iterationMs: 1_000, inactivityMs: 60_000, wrapUpMs: 0 };

    /** A project whose TASK-1 has a spec, committed so the split has history. */
    function planned(extra: Record<string, unknown> = {}): string {
      const root = project([]);
      mkdirSync(resolve(root, '.ralph', 'tasks'), { recursive: true });
      writeFileSync(resolve(root, '.ralph', 'tasks', 'TASK-1.json'), spec('TASK-1'));
      writeFileSync(
        resolve(root, '.ralph', 'tasks.json'),
        JSON.stringify([{ id: 'TASK-1', title: 'Parser and printer', specFilePath: '.ralph/tasks/TASK-1.json', passes: false, ...extra }]),
      );
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'plan'], { cwd: root });
      return root;
    }

    /** What the split agent writes. */
    function writeProposal(root: string, proposal: Record<string, unknown>, ids: string[] = []): void {
      const dir = resolve(root, '.ralph', 'split', 'TASK-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'proposal.json'), JSON.stringify({ task: 'TASK-1', ...proposal }));
      for (const id of ids) writeFileSync(resolve(dir, `${id}.json`), spec(id));
    }
    const split = {
      splittable: true,
      reason: 'Parser, then printer.',
      tasks: [
        { id: 'TASK-1.1', title: 'Parser' },
        { id: 'TASK-1.2', title: 'Printer' },
      ],
    };
    const stall = (overrides: Record<string, unknown>) => ({
      maxTimeoutsPerTask: 1,
      maxUnproductiveIterations: 5,
      ...overrides,
    });
    const splits = (historyDir: string) =>
      readFileSync(resolve(historyDir, 'splits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    const runState = (historyDir: string) => JSON.parse(readFileSync(resolve(historyDir, 'state.json'), 'utf8'));

    it('proposes a split by default and stops for review', async () => {
      const root = planned();

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({}) }), {
        onPrompt: (count) => {
          if (count === 2) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
        },
        script: (count) => (count === 1 ? endless : say('proposed')),
      });

      expect(result.status).toBe('stalled');
      expect(result.iterations).toBe(1);
      expect(result.message).toBe(
        'TASK-1 ran out of time 1 time; proposed splitting it into TASK-1.1 and TASK-1.2 in .ralph/split/TASK-1/. Review it, then run `ralph split TASK-1 --apply`',
      );
      const prompt = String(server?.prompts[1]?.['text']);
      expect(prompt).toContain('## Split TASK-1');
      expect(prompt).toContain('TASK-1 works');
      expect(prompt).toContain('.ralph/handoff/TASK-1.md');
      // Proposing changes nothing in the plan.
      expect(JSON.parse(readFileSync(resolve(root, '.ralph', 'tasks.json'), 'utf8'))).toHaveLength(1);
      expect(splits(result.historyDir)).toEqual([
        expect.objectContaining({ taskId: 'TASK-1', causes: ['iteration-timeout'], status: 'proposed', children: ['TASK-1.1', 'TASK-1.2'] }),
      ]);
      expect(existsSync(resolve(result.historyDir, 'split-TASK-1.events.jsonl'))).toBe(true);
      // The run ended on the split turn, so its state still names it.
      expect(runState(result.historyDir).split).toEqual({ taskId: 'TASK-1', startedAt: expect.any(String), phase: 'split' });
    });

    it('splits the task and carries on with the new tasks', async () => {
      const root = planned();

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({ onRepeatedTimeout: 'split' }) }), {
        onPrompt: (count) => {
          if (count === 2) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
          if (count === 3) markPassing(root, 'TASK-1.1');
          if (count === 4) markPassing(root, 'TASK-1.2');
        },
        script: (count) => (count === 1 ? endless : say(count === 2 ? 'proposed' : 'done')),
      });

      expect(result.status).toBe('complete');
      expect(result.iterations).toBe(3);
      expect(String(server?.prompts[2]?.['text'])).toContain('Work on **TASK-1.1**');
      const tasks = JSON.parse(readFileSync(resolve(root, '.ralph', 'tasks.json'), 'utf8'));
      expect(tasks.map((task: { id: string }) => task.id)).toEqual(['TASK-1.1', 'TASK-1.2']);
      expect(tasks[0]).toMatchObject({ splitFrom: 'TASK-1', splitDepth: 1, specFilePath: '.ralph/tasks/TASK-1.1.json' });
      expect(existsSync(resolve(root, '.ralph', 'split', 'TASK-1', 'TASK-1.json'))).toBe(true);
      const log = execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
      expect(log).toContain('chore(plan): split TASK-1 into TASK-1.1 and TASK-1.2');
      expect(splits(result.historyDir)).toEqual([expect.objectContaining({ status: 'applied', committed: true })]);
      // Iterations ran after the split turn.
      expect(runState(result.historyDir).split).toBeNull();
    });

    it('waits for a proposed split to be approved, then carries on with the new tasks', async () => {
      const root = planned();

      const running = waitingLoop(root, config(root, { maxIterations: 5, timeouts, stall: stall({}) }), {
        onPrompt: (count) => {
          if (count === 2) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
          if (count === 3) markPassing(root, 'TASK-1.1');
          if (count === 4) markPassing(root, 'TASK-1.2');
        },
        script: (count) => (count === 1 ? endless : say(count === 2 ? 'proposed' : 'done')),
      });
      const asked = await answer(root, { action: 'approve' });
      const result = await running;

      expect(asked).toMatchObject({
        kind: 'split',
        taskId: 'TASK-1',
        split: {
          dir: '.ralph/split/TASK-1',
          reason: 'Parser, then printer.',
          tasks: [
            { id: 'TASK-1.1', title: 'Parser', specPath: '.ralph/split/TASK-1/TASK-1.1.json' },
            { id: 'TASK-1.2', title: 'Printer', specPath: '.ralph/split/TASK-1/TASK-1.2.json' },
          ],
        },
      });
      expect(result.status).toBe('complete');
      expect(execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' })).toContain(
        'chore(plan): split TASK-1 into TASK-1.1 and TASK-1.2',
      );
      expect(splits(result.historyDir).map((record: { status: string }) => record.status)).toEqual(['proposed', 'applied']);
      expect(readPending(resolve(root, '.ralph'))).toBeUndefined();
    });

    it('takes `ralph split --apply` as approval while it waits', async () => {
      const root = planned();

      const running = waitingLoop(root, config(root, { maxIterations: 5, timeouts, stall: stall({}) }), {
        onPrompt: async (count) => {
          if (count === 2) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
          if (count === 3) markPassing(root, 'TASK-1.1');
          if (count === 4) markPassing(root, 'TASK-1.2');
        },
        script: (count) => (count === 1 ? endless : say(count === 2 ? 'proposed' : 'done')),
      });
      while (!readPending(resolve(root, '.ralph'))?.waiting) await new Promise((done) => setTimeout(done, 5));
      const { applySplit } = await import('../src/loop/split.js');
      await applySplit({ projectRoot: root, ralphDir: '.ralph', taskId: 'TASK-1', commit: true });

      expect((await running).status).toBe('complete');
    });

    it('asks for another proposal with the person\'s note, and tries the task again when told to', async () => {
      const root = planned();

      const running = waitingLoop(root, config(root, { maxIterations: 5, timeouts, stall: stall({}) }), {
        onPrompt: (count) => {
          if (count === 2 || count === 3) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
          if (count === 4) markPassing(root, 'TASK-1');
        },
        script: (count) => (count === 1 ? endless : say('ok')),
      });
      const first = await answer(root, { action: 'repropose', text: 'Split by module instead.' });
      await answer(root, { action: 'retry', text: 'Skip the slow integration suite.' }, first.id);
      const result = await running;

      expect(String(server?.prompts[2]?.['text'])).toContain('Split by module instead.');
      const retried = String(server?.prompts[3]?.['text']);
      expect(retried).toContain('Work on **TASK-1**');
      expect(retried).toContain('Skip the slow integration suite.');
      expect(result.status).toBe('complete');
    });

    it('stops with the agent\'s reason when splitting would not help', async () => {
      const root = planned();

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({ onRepeatedTimeout: 'split' }) }), {
        onPrompt: (count) => {
          if (count === 2) writeProposal(root, { splittable: false, reason: 'the e2e suite alone takes 40 minutes' });
        },
        script: (count) => (count === 1 ? endless : say('declined')),
      });

      expect(result.status).toBe('stalled');
      expect(result.message).toBe(
        'TASK-1 ran out of time 1 time; splitting it would not help: the e2e suite alone takes 40 minutes (handoff: .ralph/handoff/TASK-1.md)',
      );
      expect(splits(result.historyDir)).toEqual([expect.objectContaining({ status: 'declined' })]);
    });

    it('attempts the task again, without a person, when the agent says it is nearly done', async () => {
      const root = planned();

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({}) }), {
        onPrompt: (count) => {
          if (count === 2) writeProposal(root, { splittable: false, retry: true, reason: 'ten minutes of work are left' });
          if (count === 3) markPassing(root, 'TASK-1');
        },
        script: (count) => (count === 1 ? endless : say('ok')),
      });

      expect(result.status).toBe('complete');
      expect(String(server?.prompts[1]?.['text'])).toContain('"retry": true');
      expect(String(server?.prompts[2]?.['text'])).toContain('Work on **TASK-1**');
      expect(splits(result.historyDir)).toEqual([
        expect.objectContaining({ status: 'retry', reason: 'ten minutes of work are left' }),
      ]);
      expect(readPending(resolve(root, '.ralph'))).toBeUndefined();
    });

    it('takes that advice once: a task that stalls again is not offered it, nor given it', async () => {
      const root = planned();

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({ onRepeatedTimeout: 'split' }) }), {
        onPrompt: (count) => {
          if (count === 2 || count === 4) writeProposal(root, { splittable: false, retry: true, reason: 'ten minutes of work are left' });
        },
        script: (count) => (count % 2 === 1 ? endless : say('ok')),
      });

      expect(result.status).toBe('stalled');
      expect(result.iterations).toBe(2);
      expect(result.message).toBe(
        'TASK-1 ran out of time 1 time; splitting it would not help: ten minutes of work are left (handoff: .ralph/handoff/TASK-1.md)',
      );
      expect(String(server?.prompts[3]?.['text'])).toContain('## Split TASK-1');
      expect(String(server?.prompts[3]?.['text'])).not.toContain('"retry": true');
      expect(splits(result.historyDir).map((record: { status: string }) => record.status)).toEqual(['retry', 'declined']);
    });

    it('sends a broken proposal back, then gives up on it', async () => {
      const root = planned();

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({}) }), {
        script: (count) => (count === 1 ? endless : say('nothing written')),
      });

      expect(result.status).toBe('stalled');
      expect(result.message).toMatch(/^TASK-1 ran out of time 1 time; Ralph could not propose a split \(the proposal still has problems: .*proposal.json was not written\), so split it by hand/);
      // The first request and two attempts to fix it, all in one session.
      expect(server?.prompts).toHaveLength(4);
      expect(String(server?.prompts[2]?.['text'])).toContain('found these problems');
    });

    it('does not split a task that only ever went quiet', async () => {
      const root = planned();

      const result = await loop(
        root,
        config(root, { maxIterations: 5, timeouts: { iterationMs: 60_000, inactivityMs: 1_000, wrapUpMs: 0 }, stall: stall({ onRepeatedTimeout: 'split' }) }),
        { script: endless },
      );

      expect(result.status).toBe('stalled');
      expect(result.message).toBe(
        'TASK-1 ran out of time 1 time, going quiet each time: a command probably hangs, which splitting the task would not fix (handoff: .ralph/handoff/TASK-1.md)',
      );
      expect(server?.prompts).toHaveLength(1);
    });

    it('does not split a task split too often already', async () => {
      const root = planned({ splitFrom: 'TASK-0', splitDepth: 1 });

      const result = await loop(root, config(root, { maxIterations: 5, timeouts, stall: stall({ onRepeatedTimeout: 'split' }) }), {
        script: endless,
      });

      expect(result.status).toBe('stalled');
      expect(result.message).toBe(
        'TASK-1 ran out of time 1 time after being split from TASK-0; stall.maxSplitDepth (1) allows no further split, so split it by hand (handoff: .ralph/handoff/TASK-1.md)',
      );
      expect(server?.prompts).toHaveLength(1);
    });

    describe('assessing a task before its first attempt', () => {
      const estimate = (minutes: number) => say(`Plan: parser, then printer.\n<promise>ESTIMATE:${minutes}:parser and printer are separate changes</promise>`);
      const assessment = (root: string) => JSON.parse(readFileSync(resolve(root, '.ralph', 'assess', 'TASK-1.json'), 'utf8'));

      it('attempts a task estimated to fit, and does not assess it again', async () => {
        const root = planned();

        const result = await loop(root, config(root, { maxIterations: 5, assess: { mode: 'split' } }), {
          onPrompt: (count) => {
            if (count === 3) markPassing(root, 'TASK-1');
          },
          script: (count) => (count === 1 ? estimate(10) : say('done')),
        });

        expect(result.status).toBe('complete');
        expect(result.iterations).toBe(2);
        const triage = String(server?.prompts[0]?.['text']);
        expect(triage).toContain('## Assess TASK-1');
        expect(triage).toContain('TASK-1 works');
        expect(triage).toContain('more than 30 minutes');
        expect(String(server?.prompts[1]?.['text'])).toContain('Work on **TASK-1**');
        expect(String(server?.prompts[2]?.['text'])).toContain('Work on **TASK-1**');
        expect(server?.prompts).toHaveLength(3);
        expect(assessment(root)).toMatchObject({ task: 'TASK-1', verdict: 'fits', estimateMinutes: 10, thresholdMinutes: 30 });
        expect(splits(result.historyDir)).toEqual([
          expect.objectContaining({ taskId: 'TASK-1', iteration: 1, trigger: 'assessment', status: 'fits', estimateMinutes: 10, causes: [] }),
        ]);
        expect(existsSync(resolve(root, '.ralph', 'split'))).toBe(false);
      });

      it('splits a task estimated too big, without spending an iteration on it', async () => {
        const root = planned();

        const result = await loop(root, config(root, { maxIterations: 2, assess: { mode: 'split' } }), {
          onPrompt: (count) => {
            if (count === 2) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
            if (count === 3) markPassing(root, 'TASK-1.1');
            if (count === 4) markPassing(root, 'TASK-1.2');
          },
          script: (count) => (count === 1 ? estimate(50) : say(count === 2 ? 'proposed' : 'done')),
        });

        expect(result.status).toBe('complete');
        expect(result.iterations).toBe(2);
        const proposing = String(server?.prompts[1]?.['text']);
        expect(proposing).toContain('## Split TASK-1');
        expect(proposing).toContain('estimated at about 50 minutes');
        expect(proposing).toContain('more than the 30 minutes a task may take');
        // The split turn carried on in the triage session; the new tasks were not assessed.
        expect(server?.sessionsCreated).toBe(3);
        expect(String(server?.prompts[2]?.['text'])).toContain('Work on **TASK-1.1**');
        expect(execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' })).toContain(
          'chore(plan): split TASK-1 into TASK-1.1 and TASK-1.2',
        );
        expect(assessment(root)).toMatchObject({ verdict: 'too-big', estimateMinutes: 50 });
        expect(splits(result.historyDir)).toEqual([
          expect.objectContaining({ iteration: 1, trigger: 'assessment', status: 'applied', estimateMinutes: 50, children: ['TASK-1.1', 'TASK-1.2'] }),
        ]);
        // One file holds both turns of the session.
        const events = readFileSync(resolve(result.historyDir, 'split-TASK-1.events.jsonl'), 'utf8');
        expect(events).toContain('ESTIMATE:50');
        expect(events).toContain('proposed');
      });

      it('follows its own threshold when one is set', async () => {
        const root = planned();

        const result = await loop(root, config(root, { maxIterations: 1, assess: { mode: 'split', thresholdMs: 60 * 60_000 } }), {
          onPrompt: (count) => {
            if (count === 2) markPassing(root, 'TASK-1');
          },
          script: (count) => (count === 1 ? estimate(50) : say('done')),
        });

        expect(result.status).toBe('complete');
        expect(assessment(root)).toMatchObject({ verdict: 'fits', thresholdMinutes: 60 });
      });

      it('proposes the split and stops for review', async () => {
        const root = planned();

        const result = await loop(root, config(root, { maxIterations: 5, assess: { mode: 'propose' } }), {
          onPrompt: (count) => {
            if (count === 2) writeProposal(root, split, ['TASK-1.1', 'TASK-1.2']);
          },
          script: (count) => (count === 1 ? estimate(50) : say('proposed')),
        });

        expect(result.status).toBe('stalled');
        expect(result.iterations).toBe(0);
        expect(result.message).toBe(
          'TASK-1 was estimated at 50 minutes before any attempt, over the 30 minutes a task may take; proposed splitting it into TASK-1.1 and TASK-1.2 in .ralph/split/TASK-1/. Review it, then run `ralph split TASK-1 --apply`',
        );
        expect(JSON.parse(readFileSync(resolve(root, '.ralph', 'tasks.json'), 'utf8'))).toHaveLength(1);
        expect(readPending(resolve(root, '.ralph'))).toMatchObject({ kind: 'split', taskId: 'TASK-1', waiting: false });
        expect(splits(result.historyDir)).toEqual([expect.objectContaining({ trigger: 'assessment', status: 'proposed' })]);
        expect(runState(result.historyDir).split).toMatchObject({ taskId: 'TASK-1', phase: 'split' });
      });

      it('waits for the proposal to be approved, or attempts the task when told to', async () => {
        const approved = planned();
        const running = waitingLoop(approved, config(approved, { maxIterations: 5, assess: { mode: 'propose' } }), {
          onPrompt: (count) => {
            if (count === 2) writeProposal(approved, split, ['TASK-1.1', 'TASK-1.2']);
            if (count === 3) markPassing(approved, 'TASK-1.1');
            if (count === 4) markPassing(approved, 'TASK-1.2');
          },
          script: (count) => (count === 1 ? estimate(50) : say('ok')),
        });
        expect(await answer(approved, { action: 'approve' })).toMatchObject({ kind: 'split', taskId: 'TASK-1' });
        const result = await running;
        expect(result.status).toBe('complete');
        expect(splits(result.historyDir).map((record: { status: string }) => record.status)).toEqual(['proposed', 'applied']);
        await server?.close();

        const retried = planned();
        const again = waitingLoop(retried, config(retried, { maxIterations: 5, assess: { mode: 'propose' } }), {
          onPrompt: (count) => {
            if (count === 2) writeProposal(retried, split, ['TASK-1.1', 'TASK-1.2']);
            if (count === 3) markPassing(retried, 'TASK-1');
          },
          script: (count) => (count === 1 ? estimate(50) : say('ok')),
        });
        await answer(retried, { action: 'retry', text: 'It is smaller than it looks.' });
        expect((await again).status).toBe('complete');
        const attempt = String(server?.prompts[2]?.['text']);
        expect(attempt).toContain('Work on **TASK-1**');
        expect(attempt).toContain('It is smaller than it looks.');
      });

      it('attempts the task when the agent then advises against splitting it', async () => {
        const root = planned();

        const result = await loop(root, config(root, { maxIterations: 5, assess: { mode: 'split' } }), {
          onPrompt: (count) => {
            if (count === 2) writeProposal(root, { splittable: false, retry: true, reason: 'one change that cannot be cut' });
            if (count === 3) markPassing(root, 'TASK-1');
          },
          script: (count) => (count === 1 ? estimate(50) : say('ok')),
        });

        expect(result.status).toBe('complete');
        expect(result.iterations).toBe(1);
        expect(String(server?.prompts[2]?.['text'])).toContain('Work on **TASK-1**');
        expect(splits(result.historyDir)).toEqual([expect.objectContaining({ trigger: 'assessment', status: 'declined' })]);
      });

      it('cuts a triage turn off at its own budget, then attempts the task', async () => {
        const root = planned();

        const result = await loop(root, config(root, { maxIterations: 5, assess: { mode: 'split', timeoutMs: 500 } }), {
          onPrompt: (count) => {
            if (count === 2) markPassing(root, 'TASK-1');
          },
          script: (count) => (count === 1 ? endless : say('done')),
        });

        expect(result.status).toBe('complete');
        expect(result.iterations).toBe(1);
        expect(server?.interrupts).toBe(1);
        expect(assessment(root)).toMatchObject({ verdict: 'unknown' });
        expect(splits(result.historyDir)).toEqual([expect.objectContaining({ trigger: 'assessment', status: 'failed' })]);
      });

      it('attempts the task when the reply has no estimate, and warns when the turn changed the project', async () => {
        const root = planned();

        server = await startFakeServer({
          onPrompt: (count) => {
            if (count === 1) writeFileSync(resolve(root, 'parser.ts'), 'export {};\n');
            if (count === 2) markPassing(root, 'TASK-1');
          },
          script: (count) => say(count === 1 ? 'I went ahead and wrote the parser.' : 'done'),
        });
        const result = await runLoop({
          config: config(root, { maxIterations: 5, assess: { mode: 'split' } }),
          client: new OpencodeClient({ baseUrl: server.url }),
          logger: new Logger({ level: 'warn', stream: sink }),
          reporter,
          signal: new AbortController().signal,
        });

        expect(result.status).toBe('complete');
        expect(assessment(root)).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('no estimate') });
        expect(readFileSync(resolve(result.historyDir, 'log.jsonl'), 'utf8')).toContain('the project changed during a planning turn');
      });

      it('assesses nothing by default, nor a task that cannot be split again', async () => {
        const off = planned();
        await loop(off, config(off, { maxIterations: 1 }), { script: say('done') });
        expect(String(server?.prompts[0]?.['text'])).toContain('Work on **TASK-1**');
        await server?.close();

        const deep = planned({ splitFrom: 'TASK-0', splitDepth: 1 });
        await loop(deep, config(deep, { maxIterations: 1, assess: { mode: 'split' } }), { script: say('done') });
        expect(String(server?.prompts[0]?.['text'])).toContain('Work on **TASK-1**');
      });
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

  describe('waiting for a person', () => {
    const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    it('waits for the answer to a question, and shows it to the agent', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);

      const running = waitingLoop(root, config(root, { maxIterations: 9 }), {
        onPrompt: (count) => {
          if (count === 2) markPassing(root, 'TASK-1');
        },
        script: (count) => say(count === 1 ? '<promise>DECIDE:REST or GraphQL?</promise>' : 'done'),
      });
      const asked = await answer(root, { action: 'answer', text: 'REST, like the rest of the API.' });
      const result = await running;

      expect(asked).toMatchObject({ kind: 'decide', taskId: 'TASK-1', question: 'REST or GraphQL?' });
      expect(result.status).toBe('complete');
      expect(result.iterations).toBe(2);
      const prompt = String(server?.prompts[1]?.['text']);
      expect(prompt).toContain('## Answers from a person');
      expect(prompt).toContain('TASK-1: REST or GraphQL?');
      expect(prompt).toContain('**REST, like the rest of the API.**');
      expect(lines(resolve(root, '.ralph', 'decisions.jsonl'))).toEqual([
        expect.objectContaining({ taskId: 'TASK-1', kind: 'decide', question: 'REST or GraphQL?', answer: 'REST, like the rest of the API.' }),
      ]);
      expect(lines(resolve(result.historyDir, 'actions.jsonl'))).toEqual([
        expect.objectContaining({ kind: 'decide', action: 'answer', by: 'ui' }),
      ]);
      expect(readPending(resolve(root, '.ralph'))).toBeUndefined();
      expect(JSON.parse(readFileSync(resolve(result.historyDir, 'state.json'), 'utf8'))).toMatchObject({ status: 'complete', pending: null });
    });

    it('ends as it would have when told to stop', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const running = waitingLoop(root, config(root, { maxIterations: 9 }), {
        script: say('<promise>BLOCKED:no API key</promise>'),
      });
      await answer(root, { action: 'stop' });
      const result = await running;

      expect(result.status).toBe('blocked');
      expect(result.message).toBe('no API key');
      expect(server?.prompts).toHaveLength(1);
    });

    it('resumes a blocked or stalled run, with the person\'s note', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const running = waitingLoop(root, config(root, { maxIterations: 9, stall: { maxUnproductiveIterations: 1 } }), {
        onPrompt: (count) => {
          if (count === 3) markPassing(root, 'TASK-1');
        },
        script: (count) => say(count === 1 ? '<promise>BLOCKED:no API key</promise>' : 'done'),
      });
      const blocked = await answer(root, { action: 'resume', text: 'The key is in .env now.' });
      const stalled = await answer(root, { action: 'resume' }, blocked.id);
      const result = await running;

      expect(stalled).toMatchObject({ kind: 'stalled', message: '1 iterations in a row changed nothing (last: no-progress)' });
      expect(String(server?.prompts[1]?.['text'])).toContain('The key is in .env now.');
      expect(result.status).toBe('complete');
      expect(result.iterations).toBe(3);
    });

    it('extends a spent budget', async () => {
      const root = project([
        { id: 'TASK-1', passes: false },
        { id: 'TASK-2', passes: false },
      ]);
      const running = waitingLoop(root, config(root, { maxIterations: 1 }), {
        onPrompt: (count) => markPassing(root, `TASK-${count}`),
        script: say('done'),
      });
      const asked = await answer(root, { action: 'continue', iterations: 3 });
      const result = await running;

      expect(asked).toMatchObject({ kind: 'budget', message: 'Reached the 1 iteration budget with work outstanding' });
      expect(result.status).toBe('complete');
      expect(result.iterations).toBe(2);
      expect(String(server?.prompts[1]?.['text'])).toContain('RALPH_ITERATION=2 of 4');
    });

    it('stops waiting on a stop request, leaving the question for later', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const running = waitingLoop(root, config(root, { maxIterations: 9 }), {
        script: say('<promise>DECIDE:REST or GraphQL?</promise>'),
      });
      while (!readPending(resolve(root, '.ralph'))?.waiting) await new Promise((done) => setTimeout(done, 5));
      requestStop(resolve(root, '.ralph'), 'after-iteration', 'ui');
      const result = await running;

      expect(result.status).toBe('decide');
      expect(readPending(resolve(root, '.ralph'))).toMatchObject({ kind: 'decide', waiting: false });
      // With no loop waiting, the answer is kept for the next run.
      const done = await respond({
        projectRoot: root,
        ralphDir: '.ralph',
        input: { id: readPending(resolve(root, '.ralph'))!.id, action: 'answer', text: 'REST' },
        by: 'cli',
      });
      expect(done.delivered).toBe('applied');
      expect(lines(resolve(root, '.ralph', 'decisions.jsonl'))).toEqual([expect.objectContaining({ answer: 'REST' })]);
      expect(readPending(resolve(root, '.ralph'))).toBeUndefined();
    });

    it('stops after the current iteration on a stop request from the Ralph folder', async () => {
      const root = project([
        { id: 'TASK-1', passes: false },
        { id: 'TASK-2', passes: false },
      ]);
      const result = await waitingLoop(root, config(root, { maxIterations: 9 }), {
        onPrompt: (count) => {
          requestStop(resolve(root, '.ralph'), 'after-iteration', 'ui');
          markPassing(root, `TASK-${count}`);
        },
        script: [{ type: 'session.text.ended', data: { text: 'done' } }, { after: 150, type: 'session.execution.succeeded' }],
      });

      expect(result.status).toBe('stopped');
      expect(server?.prompts).toHaveLength(1);
      expect(existsSync(resolve(root, '.ralph', 'history', 'stop.json'))).toBe(false);
    });

    it('leaves the request but exits when the run does not wait', async () => {
      const root = project([{ id: 'TASK-1', passes: false }]);
      const result = await loop(root, config(root, { maxIterations: 9 }), {
        script: say('<promise>DECIDE:REST or GraphQL?</promise>'),
      });

      expect(result.status).toBe('decide');
      expect(readPending(resolve(root, '.ralph'))).toMatchObject({ kind: 'decide', question: 'REST or GraphQL?', waiting: false });
    });
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

  it('keeps the run state and its log lines beside the history', async () => {
    const root = project([{ id: 'TASK-1', passes: false }]);
    server = await startFakeServer({ script: say('<promise>TASK-1:DONE</promise>') });
    const infoLogger = new Logger({ level: 'info', stream: sink });
    const result = await runLoop({
      config: config(root, { maxIterations: 1 }),
      client: new OpencodeClient({ baseUrl: server.url }),
      logger: infoLogger,
      reporter,
      signal: new AbortController().signal,
    });
    infoLogger.warn('after the run');

    const state = JSON.parse(readFileSync(resolve(result.historyDir, 'state.json'), 'utf8'));
    expect(state).toMatchObject({
      runId: result.runId,
      status: 'max-iterations',
      pid: process.pid,
      iteration: 1,
      taskId: 'TASK-1',
      lastStatus: 'no-progress',
      tasksPassed: 0,
      tasksTotal: 1,
      message: result.message,
    });

    const log = readFileSync(resolve(result.historyDir, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(log).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'agent claimed a task without marking it passing' }),
    );
    expect(log.map((line) => line.message)).not.toContain('after the run');
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
