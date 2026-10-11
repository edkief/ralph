import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fakePath = fileURLToPath(new URL('./fake-pi.mjs', import.meta.url));

export interface FakePiOptions {
  /** Recorded sessions (test/fixtures/pi/<name>.jsonl) to play, in order; see fake-pi.mjs. */
  captures?: string[];
  scale?: number;
  version?: string;
  models?: Array<{ provider: string; id: string }>;
  skills?: string[];
  stallAfter?: string;
  exitOnPrompt?: number;
}

export interface FakePi {
  /** An executable that stands in for `pi`. */
  binary: string;
  /** Every command the fake received, over all the processes started from this binary. */
  commands(): Array<Record<string, unknown>>;
  /** The argument lists the fake was started with. */
  starts(): string[][];
}

/** A `pi` on disk that plays back recorded `pi --mode rpc` sessions. */
export function fakePi(options: FakePiOptions = {}): FakePi {
  const dir = mkdtempSync(resolve(tmpdir(), 'ralph-pi-'));
  const binary = resolve(dir, 'pi');
  const log = resolve(dir, 'log.jsonl');
  const config = JSON.stringify({ ...options, log });
  writeFileSync(
    binary,
    `#!${process.execPath}\nprocess.env.FAKE_PI = ${JSON.stringify(config)};\nimport(${JSON.stringify(pathToFileURL(fakePath).href)});\n`,
  );
  chmodSync(binary, 0o755);
  const entries = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { argv?: string[]; command?: Record<string, unknown> })
      : [];
  return {
    binary,
    commands: () => entries().flatMap((entry) => (entry.command ? [entry.command] : [])),
    starts: () => entries().flatMap((entry) => (entry.argv ? [entry.argv] : [])),
  };
}
