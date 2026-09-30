import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startUiServer, type UiServer } from '../src/ui/server.js';
import { Logger } from '../src/report/logger.js';
import type { LiveEvents, RunDetail, RunView, StatusView } from '../src/ui/types.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WriteStream });
const LIVE_RUN = '20260930-120000';
const OLD_RUN = '20260929-100000';

let server: UiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const say = (text: string, created = 1) => ({ type: 'session.text.ended', created, data: { sessionID: 's', text } });

/** A project mid-run: one iteration recorded, the second in progress, and an older run. */
function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-ui-'));
  const ralph = resolve(root, '.ralph');
  mkdirSync(resolve(ralph, 'prd'), { recursive: true });
  mkdirSync(resolve(ralph, 'tasks'), { recursive: true });
  writeFileSync(resolve(ralph, 'PROMPT.md'), 'Do one task.');
  writeFileSync(
    resolve(ralph, 'tasks.json'),
    JSON.stringify([
      { id: 'TASK-1', title: 'Scaffold', passes: true },
      { id: 'TASK-2', title: 'Feature', passes: false },
    ]),
  );
  writeFileSync(resolve(ralph, 'prd', 'PRD.md'), '# The product\n');
  writeFileSync(resolve(ralph, 'tasks', 'TASK-1.json'), '{}');
  writeFileSync(resolve(root, 'ralph.config.json'), '{}');
  writeFileSync(resolve(root, 'secret.txt'), 'do not serve');
  symlinkSync(resolve(root, 'secret.txt'), resolve(ralph, 'escape.txt'));

  const live = resolve(ralph, 'history', LIVE_RUN);
  mkdirSync(live, { recursive: true });
  writeFileSync(
    resolve(live, 'state.json'),
    JSON.stringify({
      runId: LIVE_RUN,
      status: 'running',
      pid: process.pid,
      hostname: hostname(),
      startedAt: '2026-09-30T12:00:00.000Z',
      updatedAt: '2026-09-30T12:10:00.000Z',
      maxIterations: 10,
      iteration: 2,
      taskId: 'TASK-2',
      iterationStartedAt: '2026-09-30T12:10:00.000Z',
      lastStatus: 'progressed',
      tasksPassed: 1,
      tasksTotal: 2,
    }),
  );
  writeFileSync(
    resolve(live, 'iterations.jsonl'),
    line({
      iteration: 1,
      taskId: 'TASK-1',
      result: { status: 'progressed', durationMs: 60_000, toolCalls: 4, usage: { input: 900, output: 100 }, compactions: 0 },
      delta: { productive: true, committed: true, tasksPassedDelta: 1 },
      startedAt: '2026-09-30T12:00:00.000Z',
      endedAt: '2026-09-30T12:01:00.000Z',
    }),
  );
  writeFileSync(resolve(live, 'iteration-001.events.jsonl'), line(say('first iteration')));
  writeFileSync(resolve(live, 'iteration-002.events.jsonl'), line(say('working on TASK-2')));
  writeFileSync(resolve(live, 'log.jsonl'), line({ time: '2026-09-30T12:00:01.000Z', level: 'warn', message: 'hello' }));

  const old = resolve(ralph, 'history', OLD_RUN);
  mkdirSync(old, { recursive: true });
  writeFileSync(resolve(old, 'run.json'), JSON.stringify({ status: 'stalled', iterations: 3, tasksPassed: 1, tasksTotal: 2 }));
  return root;
}

async function start(root: string, extra: { webRoot?: string; host?: string; basePath?: string } = {}): Promise<UiServer> {
  server = await startUiServer({
    projectRoot: root,
    ralphDir: '.ralph',
    host: extra.host ?? '127.0.0.1',
    port: 0,
    ...(extra.basePath !== undefined ? { basePath: extra.basePath } : {}),
    logger,
    pollMs: 50,
    webRoot: extra.webRoot ?? resolve(root, 'no-web'),
  });
  return server;
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server!.url}${path}`);
  const text = await response.text();
  return { status: response.status, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T };
}

/** A raw request, for headers fetch will not send. */
function raw(path: string, options: { method?: string; host?: string } = {}): Promise<number> {
  const url = new URL(path, server!.url);
  return new Promise((resolveStatus, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, method: options.method ?? 'GET', headers: options.host ? { Host: options.host } : {} },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('web UI server', () => {
  it('reports task counts and the run in progress', async () => {
    await start(project());
    const { body } = await get<StatusView>('/api/status');

    expect(body.tasks).toMatchObject({ total: 2, passed: 1, next: 'TASK-2' });
    expect(body.run).toMatchObject({ runId: LIVE_RUN, status: 'running', live: true, iteration: 2, taskId: 'TASK-2' });
  });

  it('takes a run whose process is gone as ended', async () => {
    const root = project();
    const state = resolve(root, '.ralph', 'history', LIVE_RUN, 'state.json');
    writeFileSync(state, JSON.stringify({ runId: LIVE_RUN, status: 'running', pid: 2 ** 22 + 1, hostname: hostname() }));
    await start(root);
    const { body } = await get<StatusView>('/api/status');
    expect(body.run).toMatchObject({ status: 'running', live: false });
  });

  it('lists runs newest first, older ones from their summary', async () => {
    await start(project());
    const { body } = await get<RunView[]>('/api/runs');
    expect(body.map((run) => run.runId)).toEqual([LIVE_RUN, OLD_RUN]);
    expect(body[1]).toMatchObject({ status: 'stalled', live: false, iteration: 3 });
  });

  it('lists recorded iterations and the one in progress', async () => {
    await start(project());
    const { body } = await get<RunDetail>(`/api/runs/${LIVE_RUN}`);
    expect(body.iterations).toMatchObject([
      { iteration: 1, taskId: 'TASK-1', status: 'progressed', tokens: 1000, committed: true, tasksPassedDelta: 1 },
      { iteration: 2, taskId: 'TASK-2', status: 'running' },
    ]);
  });

  it('serves a run’s log and an iteration’s transcript', async () => {
    await start(project());
    expect((await get(`/api/runs/${LIVE_RUN}/log`)).body).toEqual([
      { time: '2026-09-30T12:00:01.000Z', level: 'warn', message: 'hello' },
    ]);
    expect((await get(`/api/runs/${LIVE_RUN}/iterations/1/transcript`)).body).toMatchObject([
      { kind: 'text', text: 'first iteration' },
    ]);
    expect((await get(`/api/runs/${LIVE_RUN}/iterations/9/transcript`)).status).toBe(404);
    expect((await get('/api/runs/..%2F..%2Fetc/log')).status).toBe(404);
  });

  it('shows the Ralph folder and config, but not history or anything outside', async () => {
    await start(project());
    const { body } = await get<Array<{ path: string }>>('/api/files');
    const paths = body.map((file) => file.path);

    expect(paths).toEqual(
      expect.arrayContaining(['.ralph/PROMPT.md', '.ralph/prd/PRD.md', '.ralph/tasks/TASK-1.json', 'ralph.config.json']),
    );
    expect(paths.some((path) => path.includes('history'))).toBe(false);
    expect(paths).not.toContain('.ralph/escape.txt');

    expect((await get<{ content: string }>('/api/file?path=.ralph/prd/PRD.md')).body.content).toBe('# The product\n');
    for (const path of ['secret.txt', '.ralph/../secret.txt', '.ralph/escape.txt', `.ralph/history/${LIVE_RUN}/state.json`]) {
      expect((await get(`/api/file?path=${encodeURIComponent(path)}`)).status).toBe(404);
    }
  });

  it('is read-only and refuses foreign hosts on loopback', async () => {
    await start(project());
    expect(await raw('/api/status', { method: 'POST' })).toBe(405);
    expect(await raw('/api/status', { host: 'attacker.example' })).toBe(403);
    expect(await raw('/api/status', { host: 'localhost:1234' })).toBe(200);
  });

  it('serves everything under a proxy prefix', async () => {
    const root = project();
    const web = resolve(root, 'web');
    mkdirSync(resolve(web, 'assets'), { recursive: true });
    writeFileSync(resolve(web, 'index.html'), '<div id="root"></div>');
    writeFileSync(resolve(web, 'assets', 'app.js'), 'console.log(1)');
    await start(root, { webRoot: web, basePath: '/ralph/ws-1/' });

    expect((await get<StatusView>('/ralph/ws-1/api/status')).body.tasks).toMatchObject({ total: 2 });
    expect(await (await fetch(`${server!.url}/ralph/ws-1/`)).text()).toBe('<div id="root"></div>');
    expect((await fetch(`${server!.url}/ralph/ws-1/assets/app.js`)).headers.get('content-type')).toContain('javascript');

    const bare = await fetch(`${server!.url}/ralph/ws-1?x=1`, { redirect: 'manual' });
    expect(bare.status).toBe(308);
    expect(bare.headers.get('location')).toBe('/ralph/ws-1/?x=1');

    expect((await get('/api/status')).status).toBe(404);
    expect((await get('/ralph/ws-10/api/status')).status).toBe(404);
  });

  it('serves the app, falling back to it for client routes', async () => {
    const root = project();
    const web = resolve(root, 'web');
    mkdirSync(resolve(web, 'assets'), { recursive: true });
    writeFileSync(resolve(web, 'index.html'), '<div id="root"></div>');
    writeFileSync(resolve(web, 'assets', 'app.js'), 'console.log(1)');
    await start(root, { webRoot: web });

    const app = await fetch(`${server!.url}/assets/app.js`);
    expect(app.headers.get('content-type')).toContain('text/javascript');
    expect(await (await fetch(`${server!.url}/files/anything`)).text()).toBe('<div id="root"></div>');
    expect(await (await fetch(`${server!.url}/../../secret.txt`)).text()).toBe('<div id="root"></div>');
  });

  it('says how to build the app when it is missing', async () => {
    await start(project());
    const { status, body } = await get<string>('/');
    expect(status).toBe(503);
    expect(body).toContain('npm run build');
  });

  it('streams the status, new log lines and the transcript of the iteration in progress', async () => {
    const root = project();
    const history = resolve(root, '.ralph', 'history', LIVE_RUN);
    await start(root);
    const live = subscribe('/api/live');
    try {
      await live.until((events) => events.some((event) => event.name === 'transcript'));
      expect(live.events.find((event) => event.name === 'status')?.data).toMatchObject({ run: { runId: LIVE_RUN } });
      expect(live.events.find((event) => event.name === 'log')?.data).toMatchObject({ reset: true, lines: [{ message: 'hello' }] });
      expect(live.of('transcript')[0]).toMatchObject({
        iteration: 2,
        reset: true,
        entries: [{ kind: 'text', text: 'working on TASK-2' }],
      });

      appendFileSync(resolve(history, 'iteration-002.events.jsonl'), line({ type: 'session.text.delta', data: { sessionID: 's', delta: 'still' } }));
      appendFileSync(resolve(history, 'log.jsonl'), line({ time: 't', level: 'info', message: 'second' }));
      await live.until(() => live.of('transcript').length >= 2 && live.of('log').length >= 2);
      expect(live.of('transcript')[1]).toMatchObject({ iteration: 2, reset: false, entries: [{ text: 'still', done: false }] });
      expect(live.of('log')[1]).toMatchObject({ reset: false, lines: [{ message: 'second' }] });

      writeFileSync(resolve(history, 'iteration-003.events.jsonl'), line(say('next one')));
      await live.until(() => live.of('transcript').some((message) => message.iteration === 3));
      expect(live.of('transcript').at(-1)).toMatchObject({
        iteration: 3,
        reset: true,
        entries: [{ text: 'next one' }],
      });
    } finally {
      live.close();
    }
  });
});

type LiveEvent = { [K in keyof LiveEvents]: { name: K; data: LiveEvents[K] } }[keyof LiveEvents];

function subscribe(path: string) {
  const events: LiveEvent[] = [];
  const waiters = new Set<() => void>();
  let buffer = '';
  const req = request(new URL(path, server!.url), (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (name && data) events.push({ name, data: JSON.parse(data) } as LiveEvent);
        end = buffer.indexOf('\n\n');
      }
      for (const wake of waiters) wake();
    });
  });
  req.on('error', () => {});
  req.end();

  return {
    events,
    of<K extends keyof LiveEvents>(name: K): Array<LiveEvents[K]> {
      return events.filter((event) => event.name === name).map((event) => event.data as LiveEvents[K]);
    },
    until(predicate: (seen: LiveEvent[]) => boolean, timeoutMs = 5_000): Promise<void> {
      return new Promise((resolveWait, reject) => {
        const check = () => {
          if (!predicate(events)) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolveWait();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out; saw ${events.map((event) => event.name).join(', ')}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close: () => req.destroy(),
  };
}
