import { SseParser, type OpencodeEvent } from './events.js';

export class OpencodeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl: string;
  password?: string;
  username?: string;
  requestTimeoutMs?: number;
}

/**
 * Thin typed client over the opencode v2 HTTP API. Only the operations the
 * loop needs are exposed; `openapi()` lets preflight assert they still exist
 * on the server we are talking to.
 */
export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.authHeader = options.password
      ? `Basic ${Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64')}`
      : undefined;
  }

  get url(): string {
    return this.baseUrl;
  }

  /**
   * Cheap readiness probe. `/api/location` is served by both a standalone
   * `opencode serve` and the background service, unlike `/api/status`, which
   * only exists on the service.
   */
  async health(): Promise<{ directory?: string }> {
    return this.json('GET', '/api/location');
  }

  async openapi(): Promise<{ paths: Record<string, Record<string, { operationId?: string }>> }> {
    return this.json('GET', '/openapi.json');
  }

  async skills(): Promise<Array<{ name: string }>> {
    const body = await this.json<{ data?: Array<{ name: string }> }>('GET', '/api/skill');
    return body.data ?? [];
  }

  async mcp(): Promise<Record<string, unknown>> {
    return this.json('GET', '/api/mcp');
  }

  async defaultModel(): Promise<{ providerID?: string; modelID?: string }> {
    const body = await this.json<{ data?: { providerID?: string; modelID?: string } }>(
      'GET',
      '/api/model/default',
    );
    return body.data ?? {};
  }

  async createSession(title: string): Promise<string> {
    const body = await this.json<{ data?: { id?: string }; id?: string }>('POST', '/api/session', {
      title,
    });
    const id = body.data?.id ?? body.id;
    if (!id) throw new OpencodeApiError('Session create returned no id', 200, JSON.stringify(body));
    return id;
  }

  /**
   * Queue a prompt. Returns as soon as the server accepts it — completion is
   * observed on the event stream, not here.
   */
  async prompt(
    sessionID: string,
    text: string,
    options: { model?: string; agent?: string } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { text };
    if (options.agent) body['agent'] = options.agent;
    const model = parseModel(options.model);
    if (model) body['model'] = model;
    await this.json('POST', `/api/session/${sessionID}/prompt`, body);
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.json('POST', `/api/session/${sessionID}/interrupt`, {});
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    reply: 'once' | 'always' | 'reject',
  ): Promise<void> {
    await this.json('POST', `/api/session/${sessionID}/permission/${requestID}/reply`, { reply });
  }

  /**
   * Subscribe to the server event stream.
   *
   * Connecting is awaited here rather than inside the generator: an async
   * generator does no work until its first `next()`, which would open the
   * subscription only after the prompt had already been sent and let early
   * events slip through the gap.
   */
  async connectEvents(signal: AbortSignal): Promise<AsyncGenerator<OpencodeEvent>> {
    const response = await fetch(`${this.baseUrl}/api/event`, {
      headers: { ...this.headers(), accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new OpencodeApiError(
        `Event stream failed: ${response.status}`,
        response.status,
        await safeText(response),
      );
    }
    return readEvents(response.body, signal);
  }

  private headers(): Record<string, string> {
    return this.authHeader
      ? { authorization: this.authHeader, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new OpencodeApiError(
        `${method} ${path} failed: ${response.status}`,
        response.status,
        await safeText(response),
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** opencode wants `{providerID, modelID}`; users type `provider/model`. */
export function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Model must be "provider/model", got "${model}"`);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** Drain an already-connected SSE body into parsed events. */
async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<OpencodeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
