import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineTailer } from '../src/ui/tail.js';

const file = () => resolve(mkdtempSync(resolve(tmpdir(), 'ralph-tail-')), 'events.jsonl');

describe('LineTailer', () => {
  it('returns complete lines and keeps a partial one for later', () => {
    const path = file();
    writeFileSync(path, 'one\ntwo\nthr');
    const tailer = new LineTailer(path);
    expect(tailer.read()).toEqual({ lines: ['one', 'two'], reset: false, more: false });
    appendFileSync(path, 'ee\n');
    expect(tailer.read().lines).toEqual(['three']);
    expect(tailer.read().lines).toEqual([]);
  });

  it('takes a large file a stretch at a time', () => {
    const path = file();
    const lines = Array.from({ length: 100 }, (_, index) => `line-${String(index).padStart(3, '0')}`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const tailer = new LineTailer(path);

    const seen: string[] = [];
    let reads = 0;
    for (let read = tailer.read(64); ; read = tailer.read(64)) {
      reads += 1;
      // 64 bytes hold seven 9-byte lines, plus one carried over.
      expect(read.lines.length).toBeLessThanOrEqual(8);
      seen.push(...read.lines);
      if (!read.more) break;
    }
    expect(seen).toEqual(lines);
    expect(reads).toBeGreaterThan(10);
  });

  it('does not cut a multi-byte character at the end of a stretch', () => {
    const path = file();
    writeFileSync(path, 'héllo wörld ✓✓✓\nnext\n');
    const tailer = new LineTailer(path);
    const seen: string[] = [];
    for (let read = tailer.read(3); ; read = tailer.read(3)) {
      seen.push(...read.lines);
      if (!read.more) break;
    }
    expect(seen).toEqual(['héllo wörld ✓✓✓', 'next']);
  });

  it('reads only the end of a file when asked, from a line boundary', () => {
    const path = file();
    writeFileSync(path, 'first\nsecond\nthird\nfourth\n');
    const tailer = new LineTailer(path, { fromEnd: 16 });
    expect(tailer.read().lines).toEqual(['third', 'fourth']);
    appendFileSync(path, 'fifth\n');
    expect(tailer.read().lines).toEqual(['fifth']);
  });

  it('reads a file shorter than the tail asked for whole', () => {
    const path = file();
    writeFileSync(path, 'first\nsecond\n');
    expect(new LineTailer(path, { fromEnd: 1000 }).read().lines).toEqual(['first', 'second']);
  });

  it('starts over when the file shrinks', () => {
    const path = file();
    writeFileSync(path, 'one\ntwo\n');
    const tailer = new LineTailer(path);
    tailer.read();
    writeFileSync(path, 'new\n');
    expect(tailer.read()).toEqual({ lines: ['new'], reset: true, more: false });
  });
});
