import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TranscriptBuilder } from '../ui/transcript.js';
import { LineTailer, parseJsonLines } from '../ui/tail.js';
import type { OpencodeEvent } from '../opencode/events.js';
import type { TranscriptEntry } from '../ui/types.js';
import type { LogEntry } from './logger.js';

/** Files of a run copied as they are: small, and what the web UI shows of it. */
const COPIED = ['run.json', 'iterations.jsonl', 'splits.jsonl', 'escalations.jsonl', 'actions.jsonl'];
/** The log levels kept: debug lines are for the machine that ran it. */
const KEPT_LEVELS = new Set(['info', 'warn', 'error']);
/** What a session wrote or was sent, and a tool's input or output, kept per entry. */
const MAX_TEXT = 4_000;
const MAX_OUTPUT = 2_000;
/** A transcript beyond this keeps its start, and says how much was left out. */
const MAX_TRANSCRIPT_BYTES = 256 * 1024;

const EVENTS_FILE = /^(.+)\.events\.jsonl$/;

/**
 * Write the journal of run `runId`: what it did, in a form fit for git, so
 * another machine can see it. Mirrors `history/<runId>/` without what only
 * means something on this machine: the raw event streams become condensed
 * transcripts, the log loses its debug lines, and the state its pid and host.
 * Rewrites what changed since the last call, so it can be called as the run goes.
 */
export function writeJournal(ralphRoot: string, runId: string): string | undefined {
  const from = resolve(ralphRoot, 'history', runId);
  if (!existsSync(from)) return undefined;
  const to = resolve(ralphRoot, 'journal', runId);
  mkdirSync(to, { recursive: true });

  for (const name of COPIED) {
    if (existsSync(resolve(from, name)) && stale(resolve(from, name), resolve(to, name))) {
      copyFileSync(resolve(from, name), resolve(to, name));
    }
  }

  const state = readJson<Record<string, unknown>>(resolve(from, 'state.json'));
  if (state) {
    const { pid: _pid, hostname: _hostname, ...portable } = state;
    writeIfChanged(resolve(to, 'state.json'), `${JSON.stringify(portable, null, 2)}\n`);
  }

  if (existsSync(resolve(from, 'log.jsonl')) && stale(resolve(from, 'log.jsonl'), resolve(to, 'log.jsonl'))) {
    const kept = parseJsonLines<LogEntry>(readFileSync(resolve(from, 'log.jsonl'), 'utf8').split('\n')).filter((entry) =>
      KEPT_LEVELS.has(entry.level),
    );
    writeFileSync(resolve(to, 'log.jsonl'), kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  }

  for (const name of readdirSync(from)) {
    const match = EVENTS_FILE.exec(name);
    if (!match) continue;
    const target = resolve(to, `${match[1]}.transcript.jsonl`);
    if (stale(resolve(from, name), target)) writeFileSync(target, condensedTranscript(resolve(from, name)));
  }
  return to;
}

/** The transcript of an event file, one entry per line, each clipped and the whole bounded. */
export function condensedTranscript(eventsPath: string): string {
  const builder = new TranscriptBuilder();
  const tailer = new LineTailer(eventsPath);
  for (let read = tailer.read(); ; read = tailer.read()) {
    for (const event of parseJsonLines<OpencodeEvent>(read.lines)) builder.push(event);
    if (!read.more) break;
  }
  const entries = builder.all.map(condense);
  const lines: string[] = [];
  let bytes = 0;
  for (const [index, entry] of entries.entries()) {
    const line = `${JSON.stringify(entry)}\n`;
    if (bytes + Buffer.byteLength(line) > MAX_TRANSCRIPT_BYTES) {
      const notice: TranscriptEntry = {
        id: 'journal-cut',
        kind: 'notice',
        level: 'info',
        text: `The journal keeps the first ${index} entries of ${entries.length}; the rest is in the event file on the machine that ran it.`,
      };
      lines.push(`${JSON.stringify(notice)}\n`);
      break;
    }
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return lines.join('');
}

/** Read back a transcript the journal wrote. */
export function readJournalTranscript(path: string): TranscriptEntry[] {
  return parseJsonLines<TranscriptEntry>(readFileSync(path, 'utf8').split('\n'));
}

function condense(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case 'prompt':
    case 'text':
    case 'reasoning':
      return { ...entry, text: clip(entry.text, MAX_TEXT) };
    case 'tool': {
      const { input, output, ...rest } = entry;
      return {
        ...rest,
        ...(input ? { input: clipInput(input) } : {}),
        ...(output !== undefined ? { output: clip(output, MAX_OUTPUT) } : {}),
      };
    }
    default:
      return entry;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const clipped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') clipped[key] = clip(value, MAX_OUTPUT);
    else if (value !== null && typeof value === 'object') {
      const json = JSON.stringify(value);
      clipped[key] = json.length <= MAX_OUTPUT ? value : clip(json, MAX_OUTPUT);
    } else clipped[key] = value;
  }
  return clipped;
}

/** Whether `target` is missing or not newer than `source`. */
function stale(source: string, target: string): boolean {
  const written = statSync(target, { throwIfNoEntry: false });
  return !written || written.mtimeMs <= statSync(source).mtimeMs;
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  writeFileSync(path, content);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
