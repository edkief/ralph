import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 256 * 1024;

/**
 * Follows a file that is appended to line by line, such as an iteration's
 * event log. Each `read` returns the complete lines added since the last one
 * and keeps a trailing partial line for the next.
 *
 * Polled rather than watched: `fs.watch` misses writes on the network and
 * overlay volumes Ralph often runs on.
 */
export class LineTailer {
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');

  constructor(readonly path: string) {}

  /** New complete lines. `reset` is true when the file shrank and was read again from the start. */
  read(): { lines: string[]; reset: boolean } {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { lines: [], reset: false };
    }

    let reset = false;
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
      reset = true;
    }
    if (size === this.offset) return { lines: [], reset };

    const fd = openSync(this.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - this.offset));
      while (this.offset < size) {
        const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (read === 0) break;
        this.offset += read;
        this.partial += this.decoder.write(buffer.subarray(0, read));
      }
    } finally {
      closeSync(fd);
    }

    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    return { lines: lines.filter((line) => line.trim() !== ''), reset };
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
