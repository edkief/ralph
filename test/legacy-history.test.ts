import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryDecoder } from '../src/harness/history.js';
import { usageOfEventsFile } from '../src/metrics/usage.js';
import { TranscriptBuilder } from '../src/ui/transcript.js';

/**
 * History written by the release before the event vocabulary: raw frames as the
 * agent's server sent them, one per line, with no header. It must render and
 * count exactly as it did then.
 *
 * The `*.golden.json` files next to the fixtures were produced by the code
 * before the vocabulary existed, and are not regenerated: a change that makes
 * this test fail has changed what old history shows.
 */
const FIXTURES = resolve(__dirname, 'fixtures');

function lines(name: string): string[] {
  return readFileSync(resolve(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
}

function golden(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
}

describe.each([
  ['session-events', 'a real captured session'],
  ['legacy-extra-events', 'a session with forms, permissions, compaction, failures and a subagent'],
])('legacy history: %s (%s)', (name) => {
  it('renders the transcript as it did', () => {
    const builder = new TranscriptBuilder();
    for (const event of new HistoryDecoder().decode(lines(name))) builder.push(event);
    expect(JSON.parse(JSON.stringify(builder.all))).toEqual(golden(`${name}.transcript.golden.json`));
  });

  it('counts usage by model as it did', () => {
    const usage = usageOfEventsFile(resolve(FIXTURES, `${name}.jsonl`));
    expect(JSON.parse(JSON.stringify(usage))).toEqual(golden(`${name}.usage.golden.json`));
  });
});
