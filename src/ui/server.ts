import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RecordsMode } from '../loop/records.js';
import type { CostConfig } from '../config/schema.js';
import { costEstimator } from '../metrics/cost.js';
import { AnswerInputSchema, requestStop, RespondError, STOP_MESSAGES, STOP_MODES } from '../human/request.js';
import { respond } from '../human/respond.js';
import { DaemonRequestError, requestRun } from '../daemon/control.js';
import { COMMIT_HASH, gitCommit, gitStatus } from './git.js';
import { LOG_TAIL_BYTES, MAX_LOG_LINES, NotFoundError, RalphProject } from './project.js';
import { LineTailer, parseJsonLines } from './tail.js';
import { TranscriptBuilder } from './transcript.js';
import type { Logger } from '../report/logger.js';
import type { OpencodeEvent } from '../opencode/events.js';
import type { ActionsView, LiveEvents, LiveTranscript, LogLine, StatusView, TranscriptEntry } from './types.js';

/** The built React app, next to the compiled server: dist/ui → dist/web. */
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const STALLED_MS = 60_000;
/** Times the buffer limit beyond which a stream is dropped without waiting. */
const HARD_LIMIT_FACTOR = 4;
/** An action's body is an id and a few lines of text. */
const MAX_BODY_BYTES = 64 * 1024;

const StopSchema = z.object({ mode: z.enum(STOP_MODES) });
const RunSchema = z.object({ iterations: z.number().int().min(1).max(10_000).optional() });

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
  /** The secret requests for actions must carry; without one, actions are only taken on loopback. */
  token?: string;
  /** Take actions from other hosts without a token: access to the UI is controlled in front of it. */
  openActions?: boolean;
  logger: Logger;
  /** `git.records`: whether answers given with no loop waiting are committed. */
  records?: RecordsMode;
  /** `metrics.cost`: how the Metrics tab estimates what the work cost. */
  cost?: CostConfig;
  /** Where the built web app lives; defaults to dist/web. */
  webRoot?: string;
  /** How often live streams look for changes. */
  pollMs?: number;
  /** A live stream with more than this waiting to be read by its client is falling behind. */
  maxBufferedBytes?: number;
  /** A live stream that has been falling behind for this long is dropped. */
  stalledMs?: number;
}

/** One connection to `/api/live`. */
interface LiveClient {
  /** `whole` marks a message that replaces what the client has, such as a full transcript: large by nature. */
  write(frame: string, whole?: boolean): void;
  stop(): void;
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
 * Serve the web UI and its API. Everything is read from the project's Ralph
 * folder, and from its repository for the Git view, on each request, and
 * actions reach the loop through files there, so the server needs nothing
 * from the loop and can run beside it or on its own.
 *
 * Reading is open to whoever can reach the server. Actions change what the
 * agent does (an answer ends up in its prompt), so they are held to more:
 * only on loopback, with a token, or where whoever runs the UI has said its
 * access is controlled elsewhere, and only from the UI's own pages.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const project = new RalphProject(options.projectRoot, options.ralphDir);
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const pollMs = options.pollMs ?? POLL_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const stalledMs = options.stalledMs ?? STALLED_MS;
  const loopbackOnly = isLoopback(options.host);
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const token = options.token;
  const cost = { estimator: options.cost ? costEstimator(options.cost) : undefined, currency: options.cost?.currency ?? 'USD' };
  const actions: ActionsView =
    loopbackOnly || token || options.openActions
      ? { enabled: true, token: Boolean(token) }
      : {
          enabled: false,
          reason:
            'Actions are off: the web UI is reachable from other hosts and no ui.token is set. Set one, or set ui.actions to "open" if access to the UI is controlled in front of it',
          token: false,
        };
  const status = (): StatusView => ({ ...project.status(), actions });

  const fail = (req: IncomingMessage, res: ServerResponse, cause: unknown) => {
    if (cause instanceof NotFoundError) return sendJson(res, 404, { error: cause.message });
    if (cause instanceof RequestError) return sendJson(res, cause.code, { error: cause.message }, cause.headers);
    options.logger.warn('web UI request failed', { url: req.url ?? '', error: (cause as Error).message });
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    else res.end();
  };

  const server = createServer((req, res) => {
    try {
      const pending = handle(req, res);
      if (pending instanceof Promise) pending.catch((cause: unknown) => fail(req, res, cause));
    } catch (cause) {
      fail(req, res, cause);
    }
  });

  const handle = (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
    const write = req.method === 'POST';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !write) {
      return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD, POST' });
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
        res.end();
        return;
      }
      if (!path.startsWith(`${basePath}/`)) return sendJson(res, 404, { error: 'Not found' });
      path = path.slice(basePath.length);
    }
    if (write) return act(req, res, path);
    if (!path.startsWith('/api/')) return serveStatic(res, webRoot, path);

    if (path === '/api/status') return sendJson(res, 200, status());
    if (path === '/api/files') return sendJson(res, 200, project.listFiles());
    if (path === '/api/file') return sendJson(res, 200, project.readFile(url.searchParams.get('path') ?? ''));
    if (path === '/api/file/raw') return sendImage(res, project.imageFile(url.searchParams.get('path') ?? ''));
    if (path === '/api/runs') return sendJson(res, 200, project.listRuns());
    if (path === '/api/metrics') return sendJson(res, 200, project.metrics(cost));
    if (path === '/api/live') return live(req, res);
    if (path === '/api/git') return gitStatus(options.projectRoot).then((view) => sendJson(res, 200, view));

    const commit = /^\/api\/git\/commits\/([^/]+)$/.exec(path);
    if (commit) {
      const hash = decodeURIComponent(commit[1]!);
      if (!COMMIT_HASH.test(hash)) throw new RequestError(400, 'A commit is named by its hash');
      return gitCommit(options.projectRoot, hash).then((detail) => sendJson(res, 200, detail));
    }

    const run = /^\/api\/runs\/([^/]+)(\/log|\/iterations\/(\d+)\/transcript|\/splits\/([^/]+)\/transcript|\/escalations\/(\d+)\/transcript)?$/.exec(path);
    if (run) {
      const runId = decodeURIComponent(run[1]!);
      if (run[2] === '/log') return sendJson(res, 200, project.log(runId));
      if (run[3]) return sendJson(res, 200, project.transcript(runId, Number(run[3])));
      if (run[4]) return sendJson(res, 200, project.splitTranscript(runId, decodeURIComponent(run[4])));
      if (run[5]) return sendJson(res, 200, project.escalationTranscript(runId, Number(run[5])));
      return sendJson(res, 200, project.runDetail(runId));
    }
    return sendJson(res, 404, { error: 'Not found' });
  };

  /** Take an action: answer what the loop asked a person, ask it to stop, or have the daemon run a batch. */
  const act = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (path !== '/api/actions/respond' && path !== '/api/actions/stop' && path !== '/api/actions/run') {
      throw new RequestError(405, 'Read-only', { Allow: 'GET, HEAD' });
    }
    if (!actions.enabled) throw new RequestError(403, actions.reason ?? 'Actions are off');
    if (token && !bearerMatches(req.headers.authorization, token)) {
      throw new RequestError(401, 'This action needs the web UI token: open the UI with ?token=<ui.token>', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    // A form on another site can post here, but not as JSON: that takes a
    // CORS preflight, which is never granted.
    if (mediaType(req.headers['content-type']) !== 'application/json') {
      throw new RequestError(415, 'Actions take application/json');
    }
    if (!sameOrigin(req)) throw new RequestError(403, 'Actions are only taken from the web UI itself');

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (cause) {
      if (cause instanceof RequestError) throw cause;
      throw new RequestError(400, 'The body is not JSON');
    }

    if (path === '/api/actions/run') {
      const parsed = RunSchema.safeParse(body);
      if (!parsed.success) throw new RequestError(400, 'iterations must be a whole number from 1 to 10000');
      const { iterations } = parsed.data;
      try {
        const daemon = requestRun(project.ralphRoot, iterations, 'ui');
        const count = iterations ?? daemon.defaultIterations;
        options.logger.info('web UI action', { action: 'run', iterations: count, daemon: daemon.pid });
        return sendJson(res, 200, { message: `Ralph runs ${count} iteration${count === 1 ? '' : 's'}.` });
      } catch (cause) {
        if (cause instanceof DaemonRequestError) throw new RequestError(409, cause.message);
        throw cause;
      }
    }

    if (path === '/api/actions/stop') {
      const parsed = StopSchema.safeParse(body);
      if (!parsed.success) throw new RequestError(400, 'mode must be "after-iteration", "now" or "park"');
      const run = project.status().run;
      if (!run?.live) throw new RequestError(409, 'No run is in progress');
      requestStop(project.ralphRoot, parsed.data.mode, 'ui');
      options.logger.info('web UI action', { action: 'stop', mode: parsed.data.mode, run: run.runId });
      return sendJson(res, 200, { message: STOP_MESSAGES[parsed.data.mode] });
    }

    const parsed = AnswerInputSchema.safeParse(body);
    if (!parsed.success) throw new RequestError(400, 'The answer needs an id and an action');
    try {
      const result = await respond({
        projectRoot: options.projectRoot,
        ralphDir: options.ralphDir,
        input: parsed.data,
        by: 'ui',
        ...(options.records ? { records: options.records } : {}),
      });
      options.logger.info('web UI action', { action: parsed.data.action, request: parsed.data.id, delivered: result.delivered });
      return sendJson(res, 200, result);
    } catch (cause) {
      if (cause instanceof RespondError) throw new RequestError(cause.code === 'conflict' ? 409 : 400, cause.message);
      throw cause;
    }
  };

  /**
   * The latest run as server-sent events: the status whenever it changes, new
   * log lines, and the transcript of the session in progress (an iteration, or
   * the split turn that followed one).
   *
   * One feed serves every stream, so a second tab costs a socket rather than
   * another copy of the transcript, and it only runs while someone listens.
   */
  const clients = new Set<LiveClient>();
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lastStatus: { view: StatusView; serialized: string } | null = null;
  let logFeed: { runId: string; tailer: LineTailer } | null = null;
  let transcriptFeed: {
    runId: string;
    iteration: number;
    split: string | undefined;
    escalation: number | undefined;
    tailer: LineTailer;
    builder: TranscriptBuilder;
    /**
     * The transcript has been sent whole once. Until then the file's backlog is
     * still being read and nothing is sent; after it, only what changed is.
     */
    announced: boolean;
  } | null = null;

  const broadcast = <K extends keyof LiveEvents>(event: K, data: LiveEvents[K]) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const whole = 'reset' in data && data.reset;
    for (const client of [...clients]) client.write(frame, whole);
  };

  const transcriptMessage = (feed: NonNullable<typeof transcriptFeed>, reset: boolean, entries: TranscriptEntry[]): LiveTranscript => ({
    runId: feed.runId,
    iteration: feed.iteration,
    ...(feed.split ? { split: feed.split } : {}),
    ...(feed.escalation ? { escalation: feed.escalation } : {}),
    reset,
    entries,
  });

  /** Bring the feed up to date and tell the clients. True when the event file has more to read. */
  const tick = (): boolean => {
    const view = status();
    const serialized = JSON.stringify(view);
    if (serialized !== lastStatus?.serialized) {
      lastStatus = { view, serialized };
      broadcast('status', view);
    }

    const runId = view.run?.runId;
    if (!runId) return false;

    let logReset = false;
    if (logFeed?.runId !== runId) {
      logFeed = { runId, tailer: new LineTailer(project.logPath(runId), { fromEnd: LOG_TAIL_BYTES }) };
      logReset = true;
    }
    const logRead = logFeed.tailer.read();
    const lines = parseJsonLines<LogLine>(logRead.lines).slice(-MAX_LOG_LINES);
    if (logReset || logRead.reset || lines.length > 0) {
      broadcast('log', { runId, reset: logReset || logRead.reset, lines });
    }

    const iteration = project.latestIteration(runId);
    // The run's state names a split or escalation turn until the next iteration
    // starts; of the two, the one that started last is followed.
    const splitTask = view.run?.split?.taskId;
    const splitPath = splitTask ? project.splitEventsPath(runId, splitTask) : undefined;
    const openEscalation = view.run?.escalation;
    const escalationPath = openEscalation ? project.escalationEventsPath(runId, openEscalation.n) : undefined;
    const escalationLatest =
      escalationPath !== undefined && existsSync(escalationPath) && (!view.run?.split || openEscalation!.startedAt >= view.run.split.startedAt);
    const escalation = escalationLatest ? openEscalation!.n : undefined;
    const split = !escalation && splitPath && existsSync(splitPath) ? splitTask : undefined;
    if (iteration === 0 && !split && !escalation) return false;
    // A run known only from its journal has no event stream to follow.
    if (!split && !escalation && !existsSync(project.eventsPath(runId, iteration))) return false;
    if (
      transcriptFeed?.runId !== runId ||
      transcriptFeed.iteration !== iteration ||
      transcriptFeed.split !== split ||
      transcriptFeed.escalation !== escalation
    ) {
      transcriptFeed = {
        runId,
        iteration,
        split,
        escalation,
        tailer: new LineTailer(escalation ? escalationPath! : split ? splitPath! : project.eventsPath(runId, iteration)),
        builder: new TranscriptBuilder(),
        announced: false,
      };
    }
    const feed = transcriptFeed;
    // One stretch of the file a tick: a long iteration's backlog must not hold up the loop.
    const eventRead = feed.tailer.read();
    if (eventRead.reset) {
      feed.builder = new TranscriptBuilder();
      feed.announced = false;
    }
    // Send each changed entry once, as it stands after this batch.
    const changed = new Map<string, TranscriptEntry>();
    for (const event of parseJsonLines<OpencodeEvent>(eventRead.lines)) {
      for (const entry of feed.builder.push(event)) changed.set(entry.id, entry);
    }
    if (feed.announced) {
      if (changed.size > 0) broadcast('transcript', transcriptMessage(feed, false, [...changed.values()]));
    } else if (!eventRead.more) {
      feed.announced = true;
      broadcast('transcript', transcriptMessage(feed, true, feed.builder.all));
    }
    return eventRead.more;
  };

  const poll = (): boolean => {
    try {
      return tick();
    } catch (cause) {
      options.logger.debug('web UI live update failed', { error: (cause as Error).message });
      return false;
    }
  };

  const schedule = (more: boolean) => {
    // A backlog is read without waiting, but between other work.
    if (clients.size > 0) timer = setTimeout(() => schedule(poll()), more ? 0 : pollMs);
  };

  const live = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let fullSince: number | null = null;
    let drained = 0;
    // What may wait for this client before it is dropped without waiting. A
    // whole transcript is allowed on top: it is as large as the round is long.
    const baseLimit = maxBufferedBytes * HARD_LIMIT_FACTOR;
    let limit = baseLimit;
    const client: LiveClient = {
      write: (frame, whole = false) => {
        // A client that stopped reading (a phone asleep, a tab behind a proxy)
        // would have everything since buffered here. Drop it instead: the
        // browser reconnects and starts from what is current. One that is
        // slow but still reading is left to it.
        // What the socket has handed on, not what is still queued in it.
        const sent = (res.socket?.bytesWritten ?? 0) - (res.socket?.writableLength ?? 0);
        if (res.writableLength <= maxBufferedBytes) {
          fullSince = null;
          limit = baseLimit;
        } else if (sent > drained) fullSince = Date.now();
        else if (Date.now() - (fullSince ??= Date.now()) > stalledMs) return client.stop();
        drained = sent;
        if (res.writableLength > limit) return client.stop();
        if (whole) limit = Buffer.byteLength(frame) + baseLimit;
        res.write(frame);
      },
      stop: () => {
        if (!clients.delete(client)) return;
        res.destroy();
        if (clients.size > 0) return;
        clearTimeout(timer);
        clearInterval(heartbeat);
        timer = heartbeat = undefined;
        // Nobody is watching: the transcript need not be kept.
        lastStatus = logFeed = transcriptFeed = null;
      },
    };
    req.on('close', client.stop);

    // Bring the feed up to date for everyone, then start this client from where it stands.
    clearTimeout(timer);
    const more = poll();
    const send = <K extends keyof LiveEvents>(event: K, data: LiveEvents[K]) =>
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, true);
    clients.add(client);
    if (lastStatus) send('status', lastStatus.view);
    if (logFeed) send('log', { runId: logFeed.runId, reset: true, lines: project.log(logFeed.runId) });
    if (transcriptFeed?.announced) {
      send('transcript', transcriptMessage(transcriptFeed, true, transcriptFeed.builder.all));
    }
    schedule(more);
    heartbeat ??= setInterval(() => {
      for (const each of [...clients]) each.write(': ping\n\n');
    }, HEARTBEAT_MS);
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
        for (const client of [...clients]) client.stop();
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

/**
 * An image from the Ralph folder, as its bytes. The agent writes these files,
 * so the response is sandboxed: an SVG opened at this URL cannot run script
 * in the UI's origin.
 */
function sendImage(res: ServerResponse, image: { absolute: string; mediaType: string; size: number }): void {
  const stream = createReadStream(image.absolute);
  stream.on('error', () => res.destroy());
  stream.once('open', () => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Content-Type': image.mediaType,
      'Cache-Control': 'no-store',
    });
    stream.pipe(res);
  });
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

/** A request the server turns down, with the status to say so. */
class RequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Whether a request comes from a page this server served. Browsers say so in
 * `Sec-Fetch-Site`, and name the page's origin in `Origin`; a reverse proxy
 * that rewrites `Host` passes the original on as `X-Forwarded-Host`. A client
 * that sends neither header is not a browser, so no page is behind it.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]!.trim();
  return host !== '' && (host === req.headers.host || host === forwarded);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit the rest is read and dropped, so the refusal still reaches the client.
      if (size > MAX_BODY_BYTES) return reject(new RequestError(413, 'The body is too large', { Connection: 'close' }));
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The name in a Host header, without its port. */
function hostnameOf(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? '';
}
