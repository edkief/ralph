import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { condensedTranscript, writeJournal } from '../src/report/journal.js';
import { RalphProject } from '../src/ui/project.js';

const fixture = resolve(__dirname, 'fixtures/session-events.jsonl');
const RUN = '20261003-101500-abcd';

/** A Ralph folder with one run's history, as the loop leaves it. */
function history(): { root: string; ralphRoot: string; dir: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-journal-'));
  const ralphRoot = resolve(root, '.ralph');
  const dir = resolve(ralphRoot, 'history', RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(ralphRoot, 'tasks.json'), JSON.stringify([{ id: 'TASK-1', passes: false }]));
  writeFileSync(
    resolve(dir, 'state.json'),
    JSON.stringify({ runId: RUN, status: 'running', pid: 4242, hostname: 'laptop', startedAt: 't', updatedAt: 't', iteration: 1, maxIterations: 3, taskId: 'TASK-1', iterationStartedAt: null, lastStatus: null, tasksPassed: 0, tasksTotal: 1 }),
  );
  writeFileSync(resolve(dir, 'run.json'), JSON.stringify({ status: 'stopped', iterations: 1 }));
  const record = {
    iteration: 1,
    taskId: 'TASK-1',
    result: { status: 'progressed', durationMs: 1, toolCalls: 0, usage: { input: 1, output: 1 } },
    delta: { productive: true, committed: false, tasksPassedDelta: 0, filesChanged: 1 },
    startedAt: 't',
    endedAt: 't',
  };
  writeFileSync(resolve(dir, 'iterations.jsonl'), `${JSON.stringify(record)}\n`);
  writeFileSync(
    resolve(dir, 'log.jsonl'),
    ['debug', 'info', 'warn'].map((level) => `${JSON.stringify({ time: 't', level, message: `a ${level} line` })}\n`).join(''),
  );
  copyFileSync(fixture, resolve(dir, 'iteration-001.events.jsonl'));
  writeFileSync(resolve(ralphRoot, 'history', 'stop.json'), '{}');
  return { root, ralphRoot, dir };
}

describe('writeJournal', () => {
  it('keeps what a run did, without what only means something on its machine', () => {
    const { ralphRoot } = history();
    const to = writeJournal(ralphRoot, RUN)!;

    expect(readdirSync(to).sort()).toEqual([
      'iteration-001.transcript.jsonl',
      'iterations.jsonl',
      'log.jsonl',
      'run.json',
      'state.json',
    ]);
    const state = JSON.parse(readFileSync(resolve(to, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ runId: RUN, status: 'running' });
    expect(state).not.toHaveProperty('pid');
    expect(state).not.toHaveProperty('hostname');
    expect(readFileSync(resolve(to, 'log.jsonl'), 'utf8')).not.toContain('a debug line');
    expect(readFileSync(resolve(to, 'log.jsonl'), 'utf8')).toContain('a warn line');
    const transcript = readFileSync(resolve(to, 'iteration-001.transcript.jsonl'), 'utf8').trim().split('\n');
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript.map((line) => JSON.parse(line).kind)).toContain('text');
    expect(existsSync(resolve(ralphRoot, 'journal', 'stop.json'))).toBe(false);
  });

  it('writes nothing for a run with no history', () => {
    const { ralphRoot } = history();
    expect(writeJournal(ralphRoot, 'missing')).toBeUndefined();
  });

  it('bounds a transcript, saying how much it left out', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-journal-'));
    const path = resolve(root, 'iteration-001.events.jsonl');
    const long = 'x'.repeat(10_000);
    const events = [`${JSON.stringify({ type: 'session.created', data: { sessionID: 's' } })}`];
    for (let i = 0; i < 400; i += 1) {
      events.push(JSON.stringify({ type: 'session.text.ended', data: { sessionID: 's', assistantMessageID: `m${i}`, ordinal: 0, text: long } }));
    }
    writeFileSync(path, `${events.join('\n')}\n`);

    const text = condensedTranscript(path);
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    expect(Buffer.byteLength(text)).toBeLessThan(300 * 1024);
    expect(lines[0].text.length).toBeLessThan(4_100);
    expect(lines.at(-1)).toMatchObject({ kind: 'notice', id: 'journal-cut' });
    expect(lines.at(-1).text).toMatch(/of 400/);
  });

  it('rewrites only what changed since the last call', () => {
    const { ralphRoot } = history();
    const to = writeJournal(ralphRoot, RUN)!;
    const transcript = resolve(to, 'iteration-001.transcript.jsonl');
    writeFileSync(transcript, 'kept');
    // Newer than the event file: not rebuilt.
    writeJournal(ralphRoot, RUN);
    expect(readFileSync(transcript, 'utf8')).toBe('kept');
  });
});

describe('the web UI on a journal', () => {
  it('shows a run whose history is on another machine, never as live', () => {
    const { root, ralphRoot } = history();
    writeJournal(ralphRoot, RUN);
    // On the other machine, only what git carried is there.
    const other = mkdtempSync(resolve(tmpdir(), 'ralph-journal-'));
    mkdirSync(resolve(other, '.ralph', 'journal', RUN), { recursive: true });
    for (const name of readdirSync(resolve(ralphRoot, 'journal', RUN))) {
      copyFileSync(resolve(ralphRoot, 'journal', RUN, name), resolve(other, '.ralph', 'journal', RUN, name));
    }
    copyFileSync(resolve(ralphRoot, 'tasks.json'), resolve(other, '.ralph', 'tasks.json'));

    const project = new RalphProject(other, '.ralph');
    const runs = project.listRuns();
    expect(runs.map((run) => run.runId)).toEqual([RUN]);
    expect(runs[0]).toMatchObject({ status: 'running', live: false, iteration: 1 });
    expect(project.runDetail(RUN).iterations.map((iteration) => iteration.iteration)).toEqual([1]);
    expect(project.transcript(RUN, 1).length).toBeGreaterThan(0);
    expect(project.log(RUN).map((line) => line.message)).toEqual(['a info line', 'a warn line']);
    expect(project.listFiles().map((file) => file.path)).toEqual(['.ralph/tasks.json']);

    // Where the history is, it wins.
    expect(new RalphProject(root, '.ralph').run(RUN).runId).toBe(RUN);
    expect(new RalphProject(root, '.ralph').listRuns()).toHaveLength(1);
  });
});
