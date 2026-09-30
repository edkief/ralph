import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_LOG_LINES, NotFoundError, RalphProject } from './project.js';
import { LineTailer, parseJsonLines } from './tail.js';
import { TranscriptBuilder } from './transcript.js';
import type { Logger } from '../report/logger.js';
import type { OpencodeEvent } from '../opencode/events.js';
import type { LiveEvents, LogLine, TranscriptEntry } from './types.js';

/** The built React app, next to the compiled server: dist/ui → dist/web. */
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

export interface UiServerOptions {
  projectRoot: string;
  ralphDir: string;
  host: string;
  port: number;
  /** Path prefix a reverse proxy serves the UI under; '' serves it at the root. */
  basePath?: string;
  logger: Logger;
  /** Where the built web app lives; defaults to dist/web. */
  webRoot?: string;
  /** How often live streams look for changes. */
  pollMs?: number;
}

export interface UiServer {
  url: string;
  close(): Promise<void>;
}

export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.');
}

/**
 * Serve the web UI and its read-only API. Everything is read from the
 * project's Ralph folder on each request, so the server needs nothing from
 * the loop and can run beside it or on its own.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const project = new RalphProject(options.projectRoot, options.ralphDir);
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const pollMs = options.pollMs ?? POLL_MS;
  const loopbackOnly = isLoopback(options.host);
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const streams = new Set<() => void>();

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (cause) {
      if (cause instanceof NotFoundError) return sendJson(res, 404, { error: cause.message });
      options.logger.warn('web UI request failed', { url: req.url ?? '', error: (cause as Error).message });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Read-only' }, { Allow: 'GET, HEAD' });
    }
    // A page on another site could point a DNS name at 127.0.0.1 and read
    // the API; its requests carry that name as the Host.
    if (loopbackOnly && !isLoopback(hostnameOf(req.headers.host))) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = url.pathname;
    if (basePath) {
      // The app's URLs are relative to the page, so the prefix must end in a
      // slash for them to resolve inside it.
      if (path === basePath) {
        res.writeHead(308, { ...SECURITY_HEADERS, Location: `${basePath}/${url.search}` });
        return res.end();
      }
      if (!path.startsWith(`${basePath}/`)) return sendJson(res, 404, { error: 'Not found' });
      path = path.slice(basePath.length);
    }
    if (!path.startsWith('/api/')) return serveStatic(res, webRoot, path);

    if (path === '/api/status') return sendJson(res, 200, project.status());
    if (path === '/api/files') return sendJson(res, 200, project.listFiles());
    if (path === '/api/file') return sendJson(res, 200, project.readFile(url.searchParams.get('path') ?? ''));
    if (path === '/api/runs') return sendJson(res, 200, project.listRuns());
    if (path === '/api/live') return live(req, res);

    const run = /^\/api\/runs\/([^/]+)(\/log|\/iterations\/(\d+)\/transcript)?$/.exec(path);
    if (run) {
      const runId = decodeURIComponent(run[1]!);
      if (run[2] === '/log') return sendJson(res, 200, project.log(runId));
      if (run[3]) return sendJson(res, 200, project.transcript(runId, Number(run[3])));
      return sendJson(res, 200, project.runDetail(runId));
    }
    return sendJson(res, 404, { error: 'Not found' });
  };

  /**
   * Follow the latest run as server-sent events: the status whenever it
   * changes, new log lines, and the transcript of the iteration in progress.
   */
  const live = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = <K extends keyof LiveEvents>(event: K, data: LiveEvents[K]) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastStatus = '';
    let logFeed: { runId: string; tailer: LineTailer } | null = null;
    let transcriptFeed: { runId: string; iteration: number; tailer: LineTailer; builder: TranscriptBuilder } | null =
      null;

    const tick = () => {
      const status = project.status();
      const serialized = JSON.stringify(status);
      if (serialized !== lastStatus) {
        lastStatus = serialized;
        send('status', status);
      }

      const runId = status.run?.runId;
      if (!runId) return;

      let logReset = false;
      if (logFeed?.runId !== runId) {
        logFeed = { runId, tailer: new LineTailer(project.logPath(runId)) };
        logReset = true;
      }
      const logRead = logFeed.tailer.read();
      const lines = parseJsonLines<LogLine>(logRead.lines).slice(-MAX_LOG_LINES);
      if (logReset || logRead.reset || lines.length > 0) {
        send('log', { runId, reset: logReset || logRead.reset, lines });
      }

      const iteration = project.latestIteration(runId);
      if (iteration === 0) return;
      let transcriptReset = false;
      if (transcriptFeed?.runId !== runId || transcriptFeed.iteration !== iteration) {
        transcriptFeed = {
          runId,
          iteration,
          tailer: new LineTailer(project.eventsPath(runId, iteration)),
          builder: new TranscriptBuilder(),
        };
        transcriptReset = true;
      }
      const eventRead = transcriptFeed.tailer.read();
      if (eventRead.reset) {
        transcriptFeed.builder = new TranscriptBuilder();
        transcriptReset = true;
      }
      // Send each changed entry once, as it stands after this batch.
      const changed = new Map<string, TranscriptEntry>();
      for (const event of parseJsonLines<OpencodeEvent>(eventRead.lines)) {
        for (const entry of transcriptFeed.builder.push(event)) changed.set(entry.id, entry);
      }
      if (transcriptReset || changed.size > 0) {
        send('transcript', {
          runId,
          iteration,
          reset: transcriptReset,
          entries: transcriptReset ? transcriptFeed.builder.all : [...changed.values()],
        });
      }
    };

    const poll = () => {
      try {
        tick();
      } catch (cause) {
        options.logger.debug('web UI live update failed', { error: (cause as Error).message });
      }
    };
    poll();
    const timer = setInterval(poll, pollMs);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const stop = () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      streams.delete(stop);
      res.end();
    };
    streams.add(stop);
    req.on('close', stop);
  };

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const shownHost = options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${shownHost === '0.0.0.0' || shownHost === '[::]' ? 'localhost' : shownHost}:${port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolveClose) => {
        // Live streams never end on their own.
        for (const stop of [...streams]) stop();
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

function serveStatic(res: ServerResponse, webRoot: string, path: string): void {
  const index = resolve(webRoot, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The web UI is not built. Run `npm run build` (or `npm run build:web`) in the ralph checkout.\n');
    return;
  }

  let file = resolve(webRoot, `.${decodeURIComponent(path)}`);
  const inside = file === webRoot || file.startsWith(resolve(webRoot) + sep);
  // Unknown paths get the app, which routes on the client.
  if (!inside || !existsSync(file) || !statSync(file).isFile()) file = index;

  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(readFileSync(file));
}

function sendJson(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** The name in a Host header, without its port. */
function hostnameOf(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? '';
}
