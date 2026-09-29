import { createServer, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface ScriptedEvent {
  /** Delay before emitting, in ms. */
  after?: number;
  type: string;
  data?: Record<string, unknown>;
}

export interface FakeServerOptions {
  /** Events emitted once a prompt arrives. `{sessionID}` is filled in. */
  script: ScriptedEvent[] | ((promptCount: number) => ScriptedEvent[]);
  password?: string;
  /** Side effects a real agent would have, e.g. editing tasks.json. */
  onPrompt?: (promptCount: number) => void | Promise<void>;
}

export interface FakeServer {
  url: string;
  password: string | undefined;
  /** Permission replies the loop sent, in order. */
  replies: Array<{ requestID: string; reply: string }>;
  interrupts: number;
  prompts: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * A stand-in for opencode's HTTP API: enough of the real surface to drive the
 * loop deterministically, including slow and failing scenarios that would be
 * impossible to trigger reliably against a live model.
 */
export async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const state = {
    replies: [] as Array<{ requestID: string; reply: string }>,
    interrupts: 0,
    prompts: [] as Array<Record<string, unknown>>,
    listeners: new Set<ServerResponse>(),
    sessionId: 'ses_fake_1',
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (options.password) {
      const expected = `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401).end('unauthorized');
        return;
      }
    }

    if (path === '/api/location') return json(res, { directory: '/fake/project' });
    if (path === '/openapi.json') return json(res, fakeSpec());
    if (path === '/api/skill') return json(res, { data: [{ name: 'test-skill' }] });
    if (path === '/api/model/default') {
      return json(res, { data: { providerID: 'fake', modelID: 'model' } });
    }

    if (path === '/api/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Node holds headers back until the first body write; the client is
      // waiting on them, so flush and send a comment frame immediately —
      // the real server does the same by emitting `server.connected`.
      res.flushHeaders();
      res.write(': connected\n\n');
      state.listeners.add(res);
      req.on('close', () => state.listeners.delete(res));
      return;
    }

    if (path === '/api/session' && req.method === 'POST') {
      return json(res, { data: { id: state.sessionId } });
    }

    if (path.endsWith('/prompt') && req.method === 'POST') {
      state.prompts.push(await readBody(req));
      const promptCount = state.prompts.length;
      json(res, { data: { id: 'msg_fake' } });
      void emitScript(promptCount);
      return;
    }

    if (path.endsWith('/interrupt') && req.method === 'POST') {
      state.interrupts += 1;
      return json(res, {});
    }

    const permissionMatch = /\/permission\/([^/]+)\/reply$/.exec(path);
    if (permissionMatch && req.method === 'POST') {
      const body = (await readBody(req)) as { reply?: string };
      state.replies.push({ requestID: permissionMatch[1]!, reply: body.reply ?? '' });
      return json(res, {});
    }

    res.writeHead(404).end('not found');
  });

  async function emitScript(promptCount: number): Promise<void> {
    await options.onPrompt?.(promptCount);
    const script =
      typeof options.script === 'function' ? options.script(promptCount) : options.script;
    for (const event of script) {
      if (event.after) await new Promise((resolve) => setTimeout(resolve, event.after));
      const payload = JSON.stringify({
        type: event.type,
        data: { sessionID: state.sessionId, ...(event.data ?? {}) },
      });
      for (const listener of state.listeners) listener.write(`data: ${payload}\n\n`);
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    password: options.password,
    get replies() {
      return state.replies;
    },
    get interrupts() {
      return state.interrupts;
    },
    get prompts() {
      return state.prompts;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const listener of state.listeners) listener.end();
        // Undici keeps sockets pooled, so close() alone would wait them out.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function fakeSpec() {
  const op = (operationId: string) => ({ post: { operationId } });
  return {
    paths: {
      '/api/session': op('session.create'),
      '/api/session/{sessionID}/prompt': op('session.prompt'),
      '/api/session/{sessionID}/interrupt': op('session.interrupt'),
      '/api/session/{sessionID}/permission/{requestID}/reply': op('session.permission.reply'),
      '/api/event': { get: { operationId: 'event.subscribe' } },
    },
  };
}
