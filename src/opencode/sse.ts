import { HarnessEventSchema, type HarnessEvent } from '../harness/events.js';

/**
 * Incremental SSE frame parser. Feed it decoded chunks; it yields one parsed
 * event per complete `data:` frame and keeps any partial tail buffered.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): HarnessEvent[] {
    this.buffer += chunk;
    const events: HarnessEvent[] = [];

    let boundary = this.nextBoundary();
    while (boundary !== null) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const event = parseFrame(frame);
      if (event) events.push(event);
      boundary = this.nextBoundary();
    }
    return events;
  }

  private nextBoundary(): { index: number; length: number } | null {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    if (lf === -1 && crlf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }
}

function parseFrame(frame: string): HarnessEvent | null {
  const payload = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (!payload || payload === '[DONE]') return null;

  try {
    const parsed = HarnessEventSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
