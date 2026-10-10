import { writeFileSync } from 'node:fs';
import { OpencodeFrameSchema } from '../opencode/frames.js';
import { OpencodeTranslator } from '../opencode/translate.js';
import {
  HarnessEventSchema,
  HISTORY_HEADER_TYPE,
  HISTORY_VOCABULARY,
  HistoryHeaderSchema,
  type HarnessEvent,
  type HistoryHeader,
} from './vocab.js';

/** The header line an event file begins with, newline included. */
export function historyHeaderLine(harness: string): string {
  const header: HistoryHeader = { type: HISTORY_HEADER_TYPE, harness, vocabulary: HISTORY_VOCABULARY };
  return `${JSON.stringify(header)}\n`;
}

/** Start an event file: empty but for the header naming the harness and the vocabulary. */
export function startHistoryFile(path: string, harness: string): void {
  writeFileSync(path, historyHeaderLine(harness));
}

/**
 * Reads the lines of one event file as events in the vocabulary.
 *
 * A file Ralph wrote with the vocabulary leads with a header, and its lines
 * are events. A file without one was written by the release before it and
 * holds the raw frames of the only harness there was then; they are translated
 * as they were live, so old history renders and counts as it did.
 *
 * Feed it the file's lines in order, in as many stretches as the file is read
 * in. It decides on the first line it is given, so use a new one for each file
 * and whenever the file is read again from the start.
 */
export class HistoryDecoder {
  private mode: 'undecided' | 'current' | 'legacy' = 'undecided';
  private header: HistoryHeader | undefined;
  private readonly legacy = new OpencodeTranslator();

  /** The header of the file, once read; absent for a legacy file. */
  get fileHeader(): HistoryHeader | undefined {
    return this.header;
  }

  decode(lines: string[]): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // A torn line says nothing useful.
        continue;
      }
      if (this.mode === 'undecided') {
        const header = HistoryHeaderSchema.safeParse(value);
        this.mode = header.success ? 'current' : 'legacy';
        if (header.success) {
          this.header = header.data;
          continue;
        }
      }
      if (this.mode === 'current') {
        // Event types a newer Ralph added are not known here, and are skipped.
        const event = HarnessEventSchema.safeParse(value);
        if (event.success) events.push(event.data);
        continue;
      }
      const frame = OpencodeFrameSchema.safeParse(value);
      if (frame.success) events.push(...this.legacy.push(frame.data));
    }
    return events;
  }
}
