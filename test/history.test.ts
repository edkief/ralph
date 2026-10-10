import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryDecoder, historyHeaderLine, startHistoryFile } from '../src/harness/history.js';
import { HISTORY_VOCABULARY, type HarnessEvent } from '../src/harness/vocab.js';

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event));
const header = (extra: Record<string, unknown> = {}) => ({ type: 'history.header', harness: 'opencode', vocabulary: HISTORY_VOCABULARY, ...extra });

describe('the history header', () => {
  it('names the harness and the vocabulary version, on a line of its own', () => {
    const line = historyHeaderLine('opencode');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: 'history.header', harness: 'opencode', vocabulary: HISTORY_VOCABULARY });
    expect(HISTORY_VOCABULARY).toBe(1);
  });

  it('starts a file with nothing but the header', () => {
    const path = resolve(mkdtempSync(resolve(tmpdir(), 'ralph-history-')), 'iteration-001.events.jsonl');
    startHistoryFile(path, 'fake');
    expect(readFileSync(path, 'utf8')).toBe(historyHeaderLine('fake'));
  });
});

describe('HistoryDecoder', () => {
  it('reads the events of a file with a header as they are, and keeps the header apart', () => {
    const decoder = new HistoryDecoder();
    const events = decoder.decode(
      lines(header(), { type: 'text.ended', session: 's', text: 'hi', created: 4 }, { type: 'step.ended', session: 's', usage: { input: 3 } }),
    );
    expect(events).toEqual([
      { type: 'text.ended', session: 's', text: 'hi', created: 4 },
      { type: 'step.ended', session: 's', usage: { input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    ]);
    expect(decoder.fileHeader).toEqual(header());
  });

  it('does not translate the events of a file with a header', () => {
    // An opencode-looking type in a current file is not opencode's: it is unknown and skipped.
    const events = new HistoryDecoder().decode(lines(header(), { type: 'session.text.ended', data: { sessionID: 's', text: 'x' } }));
    expect(events).toEqual([]);
  });

  it('reads a file with no header as the raw frames of the release before', () => {
    const decoder = new HistoryDecoder();
    const events = decoder.decode(
      lines(
        { type: 'ralph.turn.started', data: { sessionID: 's', continued: false } },
        { type: 'session.text.ended', created: 2, data: { sessionID: 's', text: 'hello' } },
        { type: 'mcp.status.changed', data: {} },
      ),
    );
    expect(events).toEqual([
      { type: 'turn.started', session: 's', continued: false },
      { type: 'text.ended', created: 2, session: 's', text: 'hello' },
    ]);
    expect(decoder.fileHeader).toBeUndefined();
  });

  it('follows a tool across stretches of the same file', () => {
    const decoder = new HistoryDecoder();
    decoder.decode(lines({ type: 'session.tool.input.started', data: { sessionID: 's', id: 'c', name: 'bash' } }));
    const [called] = decoder.decode(lines({ type: 'session.tool.called', data: { sessionID: 's', id: 'c', input: {} } }));
    expect(called).toMatchObject({ type: 'tool.called', name: 'bash' });
  });

  it('decides on the first line it is given and keeps to it', () => {
    const decoder = new HistoryDecoder();
    decoder.decode(lines(header()));
    // A header again, e.g. a file started over, is not an event.
    expect(decoder.decode(lines(header(), { type: 'activity', session: 's' }))).toEqual([{ type: 'activity', session: 's' }]);
  });

  it('skips lines that are cut off, empty or not events', () => {
    const decoder = new HistoryDecoder();
    const events = decoder.decode([
      JSON.stringify(header()),
      '{"type":"text.ended","sess',
      '',
      JSON.stringify({ type: 'text.ended', session: 's' }), // no text
      JSON.stringify([1, 2]),
      JSON.stringify({ type: 'activity', session: 's' }),
    ]);
    expect(events).toEqual([{ type: 'activity', session: 's' }]);
  });

  it('reads a newer vocabulary as far as it knows it', () => {
    const events = new HistoryDecoder().decode(
      lines(
        header({ vocabulary: HISTORY_VOCABULARY + 1 }),
        { type: 'something.new', session: 's', field: 1 },
        { type: 'text.ended', session: 's', text: 'still readable', extra: 'ignored' },
      ),
    );
    expect(events).toEqual([{ type: 'text.ended', session: 's', text: 'still readable' }] satisfies HarnessEvent[]);
  });

  it('reads an empty file as no events', () => {
    expect(new HistoryDecoder().decode([])).toEqual([]);
  });
});
