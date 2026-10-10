import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/opencode/sse.js';
import { OpencodeTranslator } from '../src/opencode/translate.js';

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
    const translator = new OpencodeTranslator();
    const frames = parser.push(toSse(fixture));
    expect(frames.length).toBe(fixture.length);

    const events = frames.flatMap((frame) => translator.push(frame));

    const step = events.find((event) => event.type === 'step.ended');
    expect(step?.type === 'step.ended' && step.usage.input).toBeGreaterThan(0);

    const retry = events.find((event) => event.type === 'retry');
    expect(retry?.type === 'retry' && retry.status).toBe(429);

    const text = events.find((event) => event.type === 'text.ended');
    expect(text?.type === 'text.ended' && text.text).toBeTruthy();
  });
});
