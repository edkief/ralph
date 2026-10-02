import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { startUiServer, type UiServer } from '../src/ui/server.js';
import { readAnswer, readPending, readStopRequest, writePending } from '../src/human/request.js';
import { Logger } from '../src/report/logger.js';
import type { FileContent, GitCommitDetail, GitView, LiveEvents, RunDetail, RunView, StatusView } from '../src/ui/types.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WriteStream });
const LIVE_RUN = '20260930-120000';
const OLD_RUN = '20260929-100000';

let server: UiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A 1x1 transparent PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

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
      { id: 'TASK-2', title: 'Feature', passes: false, splitFrom: 'TASK-0', splitDepth: 1 },
    ]),
  );
  writeFileSync(resolve(ralph, 'prd', 'PRD.md'), '# The product\n');
  writeFileSync(resolve(ralph, 'tasks', 'TASK-1.json'), '{}');
  writeFileSync(resolve(ralph, 'prd', 'mockup.PNG'), PNG);
  writeFileSync(resolve(ralph, 'prd', 'diagram.svg'), SVG);
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

/** Rewrite the live run's state.json with `patch` applied. */
function patchState(root: string, patch: Record<string, unknown>): void {
  const file = resolve(root, '.ralph', 'history', LIVE_RUN, 'state.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }));
}

async function start(root: string, extra: { webRoot?: string; host?: string; basePath?: string; token?: string; openActions?: boolean } = {}): Promise<UiServer> {
  server = await startUiServer({
    projectRoot: root,
    ralphDir: '.ralph',
    host: extra.host ?? '127.0.0.1',
    port: 0,
    ...(extra.basePath !== undefined ? { basePath: extra.basePath } : {}),
    ...(extra.token ? { token: extra.token } : {}),
    ...(extra.openActions ? { openActions: true } : {}),
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
    expect(body.tasks.items[1]).toEqual({ id: 'TASK-2', title: 'Feature', passes: false, splitFrom: 'TASK-0' });
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

  it('lists split turns and serves their transcripts', async () => {
    const root = project();
    const history = resolve(root, '.ralph', 'history', LIVE_RUN);
    writeFileSync(
      resolve(history, 'splits.jsonl'),
      line({
        iteration: 1,
        taskId: 'TASK-0',
        causes: ['iteration-timeout'],
        status: 'applied',
        children: ['TASK-0.1', 'TASK-2'],
        reason: 'two halves',
        committed: true,
        startedAt: '2026-09-30T12:01:00.000Z',
        endedAt: '2026-09-30T12:03:00.000Z',
      }),
    );
    writeFileSync(resolve(history, 'split-TASK-0.events.jsonl'), line(say('splitting TASK-0')));
    // A second split turn is running: named by the state, not yet recorded.
    writeFileSync(resolve(history, 'split-TASK-2.events.jsonl'), line(say('splitting TASK-2')));
    patchState(root, { split: { taskId: 'TASK-2', startedAt: '2026-09-30T12:20:00.000Z' } });
    await start(root);

    const { body } = await get<RunDetail>(`/api/runs/${LIVE_RUN}`);
    expect(body.run.split).toEqual({ taskId: 'TASK-2', startedAt: '2026-09-30T12:20:00.000Z' });
    expect(body.splits).toEqual([
      {
        taskId: 'TASK-0',
        iteration: 1,
        status: 'applied',
        children: ['TASK-0.1', 'TASK-2'],
        reason: 'two halves',
        startedAt: '2026-09-30T12:01:00.000Z',
        endedAt: '2026-09-30T12:03:00.000Z',
        durationMs: 120_000,
      },
      { taskId: 'TASK-2', iteration: 2, status: 'running', startedAt: '2026-09-30T12:20:00.000Z', endedAt: null, durationMs: null },
    ]);

    expect((await get(`/api/runs/${LIVE_RUN}/splits/TASK-0/transcript`)).body).toMatchObject([
      { kind: 'text', text: 'splitting TASK-0' },
    ]);
    expect((await get(`/api/runs/${LIVE_RUN}/splits/TASK-9/transcript`)).status).toBe(404);
    expect((await get(`/api/runs/${LIVE_RUN}/splits/..%2Fstate/transcript`)).status).toBe(404);
  });

  it('lists the assessment of a task among the split turns', async () => {
    const root = project();
    const history = resolve(root, '.ralph', 'history', LIVE_RUN);
    writeFileSync(
      resolve(history, 'splits.jsonl'),
      line({
        iteration: 1,
        taskId: 'TASK-0',
        causes: [],
        trigger: 'assessment',
        status: 'fits',
        estimateMinutes: 12,
        reason: 'one small change',
        startedAt: '2026-09-30T12:01:00.000Z',
        endedAt: '2026-09-30T12:02:00.000Z',
      }),
    );
    // The next task is being assessed: named by the state, not yet recorded.
    writeFileSync(resolve(history, 'split-TASK-2.events.jsonl'), line(say('reading the spec')));
    patchState(root, { split: { taskId: 'TASK-2', startedAt: '2026-09-30T12:20:00.000Z', phase: 'assess' } });
    await start(root);

    const { body } = await get<RunDetail>(`/api/runs/${LIVE_RUN}`);
    expect(body.run.split).toMatchObject({ taskId: 'TASK-2', phase: 'assess' });
    expect(body.splits).toEqual([
      {
        taskId: 'TASK-0',
        iteration: 1,
        trigger: 'assessment',
        estimateMinutes: 12,
        status: 'fits',
        reason: 'one small change',
        startedAt: '2026-09-30T12:01:00.000Z',
        endedAt: '2026-09-30T12:02:00.000Z',
        durationMs: 60_000,
      },
      { taskId: 'TASK-2', iteration: 2, trigger: 'assessment', status: 'running', startedAt: '2026-09-30T12:20:00.000Z', endedAt: null, durationMs: null },
    ]);
  });

  it('reports no split turns for a run without any', async () => {
    await start(project());
    const { body } = await get<RunDetail>(`/api/runs/${LIVE_RUN}`);
    expect(body.run.split).toBeNull();
    expect(body.splits).toEqual([]);
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

  it('says an image is one, and serves its bytes sandboxed', async () => {
    await start(project(), { basePath: '/ralph' });
    const { body } = await get<FileContent>('/ralph/api/file?path=.ralph/prd/mockup.PNG');
    expect(body).toMatchObject({ mediaType: 'image/png', content: '', truncated: false, size: PNG.length });

    const png = await fetch(`${server!.url}/ralph/api/file/raw?path=.ralph/prd/mockup.PNG`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);

    const svg = await fetch(`${server!.url}/ralph/api/file/raw?path=.ralph/prd/diagram.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await svg.text()).toBe(SVG);
  });

  it('serves nothing raw but listed images', async () => {
    const root = project();
    writeFileSync(resolve(root, 'outside.png'), PNG);
    symlinkSync(resolve(root, 'outside.png'), resolve(root, '.ralph', 'escape.png'));
    writeFileSync(resolve(root, '.ralph', 'history', LIVE_RUN, 'shot.png'), PNG);
    await start(root);

    for (const path of [
      '',
      '.ralph/PROMPT.md',
      'ralph.config.json',
      'outside.png',
      '.ralph/../outside.png',
      '.ralph/escape.png',
      `.ralph/history/${LIVE_RUN}/shot.png`,
      '.ralph/prd/missing.png',
    ]) {
      expect((await get(`/api/file/raw?path=${encodeURIComponent(path)}`)).status).toBe(404);
    }
    expect(await raw('/api/file/raw?path=.ralph/prd/mockup.PNG', { method: 'POST' })).toBe(405);
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

  it('starts a second stream from what the first has seen, then sends both the same', async () => {
    const root = project();
    const events = resolve(root, '.ralph', 'history', LIVE_RUN, 'iteration-002.events.jsonl');
    await start(root);
    const first = subscribe('/api/live');
    let second: ReturnType<typeof subscribe> | undefined;
    try {
      await first.until(() => first.of('transcript').length >= 1);
      appendFileSync(events, line(say('more work')));
      await first.until(() => first.of('transcript').length >= 2);

      second = subscribe('/api/live');
      await second.until(() => second!.of('transcript').length >= 1 && second!.of('log').length >= 1 && second!.of('status').length >= 1);
      expect(second.of('transcript')[0]).toMatchObject({
        reset: true,
        entries: [{ text: 'working on TASK-2' }, { text: 'more work' }],
      });
      expect(second.of('log')[0]).toMatchObject({ reset: true, lines: [{ message: 'hello' }] });

      appendFileSync(events, line(say('and more')));
      await second.until(() => second!.of('transcript').length >= 2);
      await first.until(() => first.of('transcript').length >= 3);
      expect(second.of('transcript')[1]).toEqual(first.of('transcript')[2]);
      expect(second.of('transcript')[1]).toMatchObject({ reset: false, entries: [{ text: 'and more' }] });
    } finally {
      first.close();
      second?.close();
    }
  });

  it('reads a backlog of events a stretch at a time, then sends the transcript once', async () => {
    const root = project();
    const events = resolve(root, '.ralph', 'history', LIVE_RUN, 'iteration-002.events.jsonl');
    // More than the tailer reads in one go.
    const filler = 'x'.repeat(1000);
    let backlog = '';
    for (let index = 0; index < 9000; index += 1) backlog += line(say(`${index} ${filler}`));
    writeFileSync(events, backlog);
    await start(root);
    const live = subscribe('/api/live');
    try {
      await live.until(() => live.of('transcript').length >= 1, 15_000);
      const [message] = live.of('transcript');
      expect(message).toMatchObject({ reset: true });
      expect(message!.entries).toHaveLength(9000);
      expect(message!.entries[0]).toMatchObject({ text: expect.stringMatching(/^0 /) });
      expect(message!.entries.at(-1)).toMatchObject({ text: expect.stringMatching(/^8999 /) });
    } finally {
      live.close();
    }
  });

  it('keeps a stream that is reading, however large the transcript it is sent', async () => {
    const root = project();
    const events = resolve(root, '.ralph', 'history', LIVE_RUN, 'iteration-002.events.jsonl');
    const filler = 'x'.repeat(1000);
    let backlog = '';
    for (let index = 0; index < 3000; index += 1) backlog += line(say(`${index} ${filler}`));
    writeFileSync(events, backlog);
    // Limits far below the transcript's size: only a client that stops reading may be dropped.
    server = await startUiServer({
      projectRoot: root,
      ralphDir: '.ralph',
      host: '127.0.0.1',
      port: 0,
      logger,
      pollMs: 20,
      maxBufferedBytes: 16 * 1024,
      stalledMs: 200,
      webRoot: resolve(root, 'no-web'),
    });
    const live = subscribe('/api/live');
    try {
      await live.until(() => live.of('transcript').length >= 1, 15_000);
      expect(live.of('transcript')[0]!.entries).toHaveLength(3000);
      appendFileSync(events, line(say('and on')));
      await live.until(() => live.of('transcript').length >= 2);
      expect(live.of('transcript')[1]).toMatchObject({ reset: false, entries: [{ text: 'and on' }] });
    } finally {
      live.close();
    }
  });

  it('drops a stream whose client stopped reading', async () => {
    const root = project();
    const log = resolve(root, '.ralph', 'history', LIVE_RUN, 'log.jsonl');
    server = await startUiServer({
      projectRoot: root,
      ralphDir: '.ralph',
      host: '127.0.0.1',
      port: 0,
      logger,
      pollMs: 20,
      maxBufferedBytes: 64 * 1024,
      stalledMs: 200,
      webRoot: resolve(root, 'no-web'),
    });
    const url = new URL(server.url);
    const socket = connect(Number(url.port), url.hostname);
    const closed = new Promise<void>((resolveClosed) => socket.once('close', () => resolveClosed()));
    socket.on('error', () => {});
    socket.write(`GET /api/live HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
    socket.pause();

    // Far more than the kernel's socket buffers hold, so it backs up in the server.
    const big = line({ time: 't', level: 'info', message: 'y'.repeat(100_000) });
    for (let batch = 0; batch < 30; batch += 1) {
      appendFileSync(log, big.repeat(10));
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    // The server hung up; reading what was already sent reaches the end.
    socket.resume();
    await closed;

    // Others are still served. The log is far beyond what this server's small limit allows a stream.
    writeFileSync(log, '');
    const live = subscribe('/api/live');
    try {
      await live.until(() => live.of('status').length >= 1 && live.of('transcript').length >= 1);
    } finally {
      live.close();
    }
  });

  it('follows a split turn while it runs, then the next iteration', async () => {
    const root = project();
    const history = resolve(root, '.ralph', 'history', LIVE_RUN);
    await start(root);
    const live = subscribe('/api/live');
    try {
      await live.until(() => live.of('transcript').length >= 1);
      expect(live.of('transcript')[0]).toMatchObject({ iteration: 2, reset: true });
      expect(live.of('transcript')[0]).not.toHaveProperty('split');

      writeFileSync(resolve(history, 'split-TASK-2.events.jsonl'), line(say('reading the spec')));
      patchState(root, { split: { taskId: 'TASK-2', startedAt: '2026-09-30T12:20:00.000Z' } });
      await live.until(() => live.of('transcript').some((message) => message.split === 'TASK-2'));
      expect(live.of('transcript').at(-1)).toMatchObject({
        iteration: 2,
        split: 'TASK-2',
        reset: true,
        entries: [{ text: 'reading the spec' }],
      });
      expect(live.of('status').at(-1)).toMatchObject({ run: { split: { taskId: 'TASK-2' } } });

      appendFileSync(resolve(history, 'split-TASK-2.events.jsonl'), line({ type: 'session.text.delta', data: { sessionID: 's', delta: 'two tasks' } }));
      await live.until(() => live.of('transcript').some((message) => message.split === 'TASK-2' && !message.reset));
      expect(live.of('transcript').at(-1)).toMatchObject({ split: 'TASK-2', reset: false, entries: [{ text: 'two tasks' }] });

      // The split is applied and the loop starts on the first new task.
      writeFileSync(resolve(history, 'iteration-003.events.jsonl'), line(say('first half')));
      patchState(root, { split: null, iteration: 3 });
      await live.until(() => live.of('transcript').some((message) => message.iteration === 3));
      expect(live.of('transcript').at(-1)).toMatchObject({ iteration: 3, reset: true, entries: [{ text: 'first half' }] });
      expect(live.of('transcript').at(-1)).not.toHaveProperty('split');
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

describe('web UI actions', () => {
  /** Mark the live run as waiting on a question, as the loop does. */
  function ask(root: string, patch: Record<string, unknown> = {}): void {
    const state = resolve(root, '.ralph', 'history', LIVE_RUN, 'state.json');
    writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), status: 'waiting' }));
    writePending(resolve(root, '.ralph'), {
      id: `${LIVE_RUN}-1`,
      runId: LIVE_RUN,
      kind: 'decide',
      taskId: 'TASK-2',
      message: 'REST or GraphQL?',
      question: 'REST or GraphQL?',
      waiting: true,
      createdAt: '2026-09-30T12:11:00.000Z',
      ...patch,
    });
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${server!.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as { error?: string; message?: string; delivered?: string }, headers: response.headers };
  }
  const reply = { id: `${LIVE_RUN}-1`, action: 'answer', text: 'REST' };

  it('shows what the loop asked, and what can be done about it', async () => {
    const root = project();
    ask(root);
    await start(root);
    const { body } = await get<StatusView>('/api/status');

    expect(body.run).toMatchObject({ status: 'waiting', live: true });
    expect(body.pending).toMatchObject({ kind: 'decide', taskId: 'TASK-2', question: 'REST or GraphQL?', waiting: true, answered: false, actions: ['answer', 'stop'] });
    expect(body.actions).toEqual({ enabled: true, token: false });
  });

  it('hands an answer to the waiting loop, once', async () => {
    const root = project();
    ask(root);
    await start(root);

    const first = await post('/api/actions/respond', reply);
    expect(first).toMatchObject({ status: 200, body: { delivered: 'loop' } });
    expect(readAnswer(resolve(root, '.ralph'))).toMatchObject({ ...reply, by: 'ui' });
    expect((await get<StatusView>('/api/status')).body.pending).toMatchObject({ answered: true });

    expect((await post('/api/actions/respond', reply)).status).toBe(409);
  });

  it('turns down answers that do not fit', async () => {
    const root = project();
    await start(root);
    expect((await post('/api/actions/respond', reply)).status).toBe(409);

    ask(root);
    expect((await post('/api/actions/respond', { ...reply, id: 'other' })).status).toBe(409);
    expect((await post('/api/actions/respond', { ...reply, action: 'approve' })).status).toBe(400);
    expect((await post('/api/actions/respond', { ...reply, text: '' })).status).toBe(400);
    expect((await post('/api/actions/respond', { action: 'answer' })).status).toBe(400);
    expect((await post('/api/actions/respond', 'not json')).status).toBe(400);
    expect((await post('/api/actions/respond', { ...reply, text: 'x'.repeat(70_000) })).status).toBe(413);
    expect(readAnswer(resolve(root, '.ralph'))).toBeUndefined();
  });

  it('applies a split itself when no loop is waiting', async () => {
    const root = project();
    const ralph = resolve(root, '.ralph');
    const spec = (id: string) => JSON.stringify({ id, title: id, acceptanceCriteria: [`${id} works`] });
    mkdirSync(resolve(ralph, 'split', 'TASK-2'), { recursive: true });
    writeFileSync(
      resolve(ralph, 'split', 'TASK-2', 'proposal.json'),
      JSON.stringify({ task: 'TASK-2', splittable: true, reason: 'Two halves.', tasks: [{ id: 'TASK-2.1', title: 'First' }, { id: 'TASK-2.2', title: 'Second' }] }),
    );
    for (const id of ['TASK-2.1', 'TASK-2.2']) writeFileSync(resolve(ralph, 'split', 'TASK-2', `${id}.json`), spec(id));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'plan'], { cwd: root });
    // The run stopped over the proposal instead of waiting.
    writeFileSync(resolve(ralph, 'history', LIVE_RUN, 'state.json'), JSON.stringify({ runId: LIVE_RUN, status: 'stalled', pid: process.pid, hostname: hostname() }));
    writePending(ralph, { id: 'p-1', runId: LIVE_RUN, kind: 'split', taskId: 'TASK-2', message: 'TASK-2 ran out of time', waiting: false, createdAt: 't' });
    await start(root);

    expect((await get<StatusView>('/api/status')).body.pending).toMatchObject({ waiting: false, actions: ['approve', 'dismiss'] });
    const { status, body } = await post('/api/actions/respond', { id: 'p-1', action: 'approve' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ delivered: 'applied' });
    expect(body.message).toContain('Split TASK-2 into TASK-2.1 and TASK-2.2 and committed it');
    expect((await get<StatusView>('/api/status')).body.tasks.items.map((task) => task.id)).toEqual(['TASK-1', 'TASK-2.1', 'TASK-2.2']);
    expect(readPending(ralph)).toBeUndefined();
    expect(readFileSync(resolve(ralph, 'history', LIVE_RUN, 'actions.jsonl'), 'utf8')).toContain('"action":"approve"');
  });

  it('asks a run in progress to stop, and only one', async () => {
    const root = project();
    await start(root);

    expect((await post('/api/actions/stop', { mode: 'sometime' })).status).toBe(400);
    expect((await post('/api/actions/stop', { mode: 'after-iteration' })).status).toBe(200);
    expect(readStopRequest(resolve(root, '.ralph'))).toEqual({ mode: 'after-iteration' });

    writeFileSync(resolve(root, '.ralph', 'history', LIVE_RUN, 'state.json'), JSON.stringify({ runId: LIVE_RUN, status: 'complete', pid: process.pid, hostname: hostname() }));
    expect((await post('/api/actions/stop', { mode: 'now' })).status).toBe(409);
  });

  it('takes actions only as JSON, which a form on another site cannot send', async () => {
    const root = project();
    ask(root);
    await start(root);

    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data']) {
      expect((await post('/api/actions/respond', JSON.stringify(reply), { 'Content-Type': type })).status).toBe(415);
    }
    // A preflight gets no permission to send JSON from elsewhere.
    const preflight = await fetch(`${server!.url}/api/actions/respond`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(readAnswer(resolve(root, '.ralph'))).toBeUndefined();
  });

  it('takes actions only from its own pages', async () => {
    const root = project();
    ask(root);
    await start(root);
    const own = new URL(server!.url).host;

    expect((await post('/api/actions/respond', reply, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post('/api/actions/respond', reply, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await post('/api/actions/respond', reply, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/actions/respond', reply, { Origin: 'null' })).status).toBe(403);
    expect(readAnswer(resolve(root, '.ralph'))).toBeUndefined();

    // Behind a reverse proxy, the page's origin is the proxy's.
    expect((await post('/api/actions/respond', reply, { Origin: 'https://ralph.example', 'X-Forwarded-Host': 'ralph.example' })).status).toBe(200);
    rmAnswer(root);
    expect((await post('/api/actions/respond', reply, { Origin: `http://${own}`, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });

  it('takes no actions from other hosts without a token', async () => {
    const root = project();
    ask(root);
    await start(root, { host: '0.0.0.0' });

    const refused = await post('/api/actions/respond', reply);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('no ui.token is set');
    expect(refused.body.error).toContain('ui.actions');
    expect((await post('/api/actions/stop', { mode: 'now' })).status).toBe(403);
    expect((await get<StatusView>('/api/status')).body.actions).toMatchObject({ enabled: false, token: false });
    expect(existsSync(resolve(root, '.ralph', 'history', 'answer.json'))).toBe(false);
    expect(existsSync(resolve(root, '.ralph', 'history', 'stop.json'))).toBe(false);
  });

  it('takes actions from other hosts without a token when they are open', async () => {
    const root = project();
    ask(root);
    await start(root, { host: '0.0.0.0', openActions: true });

    expect((await get<StatusView>('/api/status')).body.actions).toEqual({ enabled: true, token: false });
    expect((await post('/api/actions/respond', reply, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post('/api/actions/respond', JSON.stringify(reply), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post('/api/actions/respond', reply)).status).toBe(200);
  });

  it('still requires a token that is set when actions are open', async () => {
    const root = project();
    ask(root);
    await start(root, { host: '0.0.0.0', token: 's3cret', openActions: true });

    expect((await get<StatusView>('/api/status')).body.actions).toEqual({ enabled: true, token: true });
    expect((await post('/api/actions/respond', reply)).status).toBe(401);
    expect((await post('/api/actions/respond', reply, { Authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('requires the token when one is set', async () => {
    const root = project();
    ask(root);
    await start(root, { host: '0.0.0.0', token: 's3cret' });

    expect((await get<StatusView>('/api/status')).body.actions).toEqual({ enabled: true, token: true });
    const missing = await post('/api/actions/respond', reply);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await post('/api/actions/respond', reply, { Authorization: 'Bearer wrong!' })).status).toBe(401);
    expect((await post('/api/actions/respond', reply, { Authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('keeps everything else read-only', async () => {
    await start(project());
    expect((await post('/api/status', {})).status).toBe(405);
    expect((await post('/api/file?path=.ralph/PROMPT.md', {})).status).toBe(405);
    expect(await raw('/api/actions/respond', { method: 'DELETE' })).toBe(405);
    expect(await raw('/api/actions/respond', { method: 'POST', host: 'evil.example' })).toBe(403);
  });
});

function rmAnswer(root: string): void {
  rmSync(resolve(root, '.ralph', 'history', 'answer.json'), { force: true });
}

describe('web UI git', () => {
  type Repository = Extract<GitView, { available: true }>;

  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
    }).trim();

  /** A project under git with three commits: a first one, a change with a body, and a rename beside a binary file. */
  function repository(): string {
    const root = project();
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(resolve(root, 'a.txt'), 'one\ntwo\nthree\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'first');
    writeFileSync(resolve(root, 'a.txt'), 'one\n2\nthree\nfour\n');
    git(root, 'commit', '-qam', 'change a', '-m', 'Why it changed.\n\nAnd more.');
    git(root, 'mv', 'a.txt', 'renamed file.txt');
    writeFileSync(resolve(root, 'pixel.png'), PNG);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'move a, add a picture');
    return root;
  }

  it('reports the branch, a clean tree and the commits, newest first', async () => {
    const root = repository();
    await start(root);
    const { status, body } = await get<Repository>('/api/git');

    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, branch: 'main', upstream: null, ahead: 0, behind: 0, changes: [], changesTruncated: false });
    expect(body.head).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(body.commits.map((commit) => commit.subject)).toEqual(['move a, add a picture', 'change a', 'first']);
    expect(body.commits[0]).toMatchObject({ hash: body.head, shortHash: git(root, 'rev-parse', '--short', 'HEAD'), author: 'Test' });
    expect(Number.isNaN(Date.parse(body.commits[0]!.date))).toBe(false);
  });

  it('lists what is uncommitted, staged or not', async () => {
    const root = repository();
    writeFileSync(resolve(root, 'renamed file.txt'), 'changed\n');
    writeFileSync(resolve(root, 'new.txt'), 'new\n');
    writeFileSync(resolve(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    git(root, 'mv', 'pixel.png', 'dot.png');
    rmSync(resolve(root, 'ralph.config.json'));
    await start(root);

    const { changes } = (await get<Repository>('/api/git')).body;
    expect([...changes].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'dot.png', status: 'renamed', staged: true, unstaged: false, from: 'pixel.png' },
      { path: 'new.txt', status: 'untracked', staged: false, unstaged: true },
      { path: 'ralph.config.json', status: 'deleted', staged: false, unstaged: true },
      { path: 'renamed file.txt', status: 'modified', staged: false, unstaged: true },
      { path: 'staged.txt', status: 'added', staged: true, unstaged: false },
    ]);
  });

  it('reports how far the branch is from its upstream, and a detached head', async () => {
    const root = repository();
    git(root, 'branch', 'base', 'HEAD~1');
    git(root, 'branch', '--set-upstream-to=base');
    await start(root);
    expect((await get<Repository>('/api/git')).body).toMatchObject({ branch: 'main', upstream: 'base', ahead: 1, behind: 0 });

    git(root, 'checkout', '-q', '--detach', 'HEAD~2');
    const detached = (await get<Repository>('/api/git')).body;
    expect(detached).toMatchObject({ branch: null, upstream: null });
    expect(detached.commits.map((commit) => commit.subject)).toEqual(['first']);
  });

  it('shows a commit with its message and the files it changed', async () => {
    const root = repository();
    await start(root);

    const changed = await get<GitCommitDetail>(`/api/git/commits/${git(root, 'rev-parse', '--short', 'HEAD~1')}`);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      hash: git(root, 'rev-parse', 'HEAD~1'),
      subject: 'change a',
      body: 'Why it changed.\n\nAnd more.',
      author: 'Test',
      email: 'test@example.com',
      parents: [git(root, 'rev-parse', 'HEAD~2')],
      files: [{ path: 'a.txt', added: 2, removed: 1, binary: false }],
      filesChanged: 1,
      added: 2,
      removed: 1,
    });

    const moved = (await get<GitCommitDetail>(`/api/git/commits/${git(root, 'rev-parse', 'HEAD')}`)).body;
    expect(moved.body).toBe('');
    expect(moved.files).toEqual([
      { path: 'pixel.png', added: 0, removed: 0, binary: true },
      { path: 'renamed file.txt', from: 'a.txt', added: 0, removed: 0, binary: false },
    ]);

    const first = (await get<GitCommitDetail>(`/api/git/commits/${git(root, 'rev-parse', 'HEAD~2')}`)).body;
    expect(first.parents).toEqual([]);
    expect(first.files.map((file) => file.path)).toContain('a.txt');
  });

  it('compares a merge with its first parent', async () => {
    const root = repository();
    git(root, 'checkout', '-q', '-b', 'side', 'HEAD~1');
    writeFileSync(resolve(root, 'side.txt'), 'side\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'side');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    await start(root);

    const merge = (await get<GitCommitDetail>(`/api/git/commits/${git(root, 'rev-parse', 'HEAD')}`)).body;
    expect(merge.parents).toHaveLength(2);
    expect(merge.files).toEqual([{ path: 'side.txt', added: 1, removed: 0, binary: false }]);
  });

  it('takes only a hash for a commit, and says when there is none', async () => {
    const root = repository();
    await start(root);

    for (const name of ['HEAD', 'main', '--all', 'a;b', 'HEAD~1', 'abc']) {
      expect((await get(`/api/git/commits/${encodeURIComponent(name)}`)).status).toBe(400);
    }
    expect((await get('/api/git/commits/0123456789abcdef0123456789abcdef01234567')).status).toBe(404);
    expect(await raw('/api/git', { method: 'POST' })).toBe(405);
    expect(await raw(`/api/git/commits/${git(root, 'rev-parse', 'HEAD')}`, { method: 'POST' })).toBe(405);
    expect(await raw('/api/git', { host: 'attacker.example' })).toBe(403);
  });

  it('says so when the project is not a repository, or has no commit yet', async () => {
    const root = project();
    await start(root);
    const none = await get<GitView>('/api/git');
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ available: false, reason: 'The project is not a git repository' });
    expect((await get('/api/git/commits/abcd1234')).status).toBe(404);
    expect((await get<StatusView>('/api/status')).body.tasks.total).toBe(2);

    git(root, 'init', '-q', '-b', 'main');
    const empty = (await get<Repository>('/api/git')).body;
    expect(empty).toMatchObject({ available: true, branch: 'main', head: null, commits: [] });
    expect(empty.changes.some((change) => change.path === 'ralph.config.json' && change.status === 'untracked')).toBe(true);
  });

  it('serves the repository under a proxy prefix', async () => {
    const root = repository();
    await start(root, { basePath: '/ralph/ws-1' });
    expect((await get<Repository>('/ralph/ws-1/api/git')).body.commits).toHaveLength(3);
    expect((await get(`/ralph/ws-1/api/git/commits/${git(root, 'rev-parse', 'HEAD')}`)).status).toBe(200);
  });
});
