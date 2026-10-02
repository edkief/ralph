import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 256 * 1024;
/**
 * Bytes one `read` takes from the file at most. Event files grow to hundreds
 * of megabytes over a long iteration, and one read whole costs several times
 * its size in memory.
 */
export const READ_BYTES = 4 * 1024 * 1024;

/**
 * Follows a file that is appended to line by line, such as an iteration's
 * event log. Each `read` returns complete lines added since the last one, up
 * to a budget, and keeps a trailing partial line for the next.
 *
 * Polled rather than watched: `fs.watch` misses writes on the network and
 * overlay volumes Ralph often runs on.
 */
export class LineTailer {
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  /** The first line read is the end of one that began before `fromEnd`. */
  private torn = false;

  /** `fromEnd` starts that many bytes before the end of the file, for a reader that only wants its tail. */
  constructor(
    readonly path: string,
    options: { fromEnd?: number } = {},
  ) {
    if (options.fromEnd === undefined) return;
    try {
      this.offset = Math.max(0, statSync(path).size - options.fromEnd);
      this.torn = this.offset > 0;
    } catch {
      // Not there yet: read it from the start once it is.
    }
  }

  /**
   * New complete lines, from at most `maxBytes` of the file; `more` is true
   * when the file has more to give. `reset` is true when the file shrank and
   * was read again from the start.
   */
  read(maxBytes: number = READ_BYTES): { lines: string[]; reset: boolean; more: boolean } {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { lines: [], reset: false, more: false };
    }

    let reset = false;
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
      this.torn = false;
      reset = true;
    }
    if (size === this.offset) return { lines: [], reset, more: false };

    const end = Math.min(size, this.offset + maxBytes);
    const fd = openSync(this.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK, end - this.offset));
      while (this.offset < end) {
        const read = readSync(fd, buffer, 0, Math.min(buffer.length, end - this.offset), this.offset);
        if (read === 0) break;
        this.offset += read;
        this.partial += this.decoder.write(buffer.subarray(0, read));
      }
    } finally {
      closeSync(fd);
    }

    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    if (this.torn && lines.length > 0) {
      lines.shift();
      this.torn = false;
    }
    return { lines: lines.filter((line) => line.trim() !== ''), reset, more: this.offset < size };
  }
}

/** Parse JSON lines, skipping any that are not valid JSON (e.g. cut off by a crash). */
export function parseJsonLines<T = unknown>(lines: string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line says nothing useful.
    }
  }
  return out;
}
