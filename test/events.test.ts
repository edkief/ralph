import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SseParser,
  readData,
  StepEndedSchema,
  RetryScheduledSchema,
  TextEndedSchema,
} from '../src/opencode/events.js';

const fixture = readFileSync(resolve(__dirname, 'fixtures/session-events.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean);

function toSse(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join('');
}

describe('SseParser', () => {
  it('parses every frame from a real captured session', () => {
    const parser = new SseParser();
    const events = parser.push(toSse(fixture));
    expect(events).toHaveLength(fixture.length);
    expect(events.map((event) => event.type)).toContain('session.tool.called');
  });

  it('buffers frames split across chunk boundaries', () => {
    const parser = new SseParser();
    const stream = toSse(fixture.slice(0, 3));
    const mid = Math.floor(stream.length / 2);

    const first = parser.push(stream.slice(0, mid));
    const second = parser.push(stream.slice(mid));

    expect(first.length + second.length).toBe(3);
  });

  it('handles CRLF frame separators and ignores keep-alive comments', () => {
    const parser = new SseParser();
    const events = parser.push(`: keep-alive\r\n\r\ndata: {"type":"ping"}\r\n\r\n`);
    expect(events.map((event) => event.type)).toEqual(['ping']);
  });

  it('skips malformed payloads instead of throwing', () => {
    const parser = new SseParser();
    expect(parser.push('data: not-json\n\ndata: {"type":"ok"}\n\n')).toHaveLength(1);
  });

  it('reads token usage and retry errors from real payloads', () => {
    const parser = new SseParser();
    const events = parser.push(toSse(fixture));

    const step = events.find((event) => event.type === 'session.step.ended');
    const usage = readData(step!, StepEndedSchema);
    expect(usage?.tokens?.input).toBeGreaterThan(0);

    const retry = events.find((event) => event.type === 'session.retry.scheduled');
    const error = readData(retry!, RetryScheduledSchema);
    expect(error?.error?.status).toBe(429);

    const text = events.find((event) => event.type === 'session.text.ended');
    expect(readData(text!, TextEndedSchema)?.text).toBeTruthy();
  });
});
