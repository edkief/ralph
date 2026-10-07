import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileInterviewIO } from '../src/init/file-io.js';
import {
  livePlan,
  PlanRecorder,
  PlanRequestError,
  readConversation,
  readPlanState,
  requestPlanStop,
  writePlanReply,
} from '../src/init/record.js';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await tick(5);
  }
}

const open: Array<{ io: FileInterviewIO; recorder: PlanRecorder }> = [];

afterEach(() => {
  for (const { io, recorder } of open.splice(0)) {
    io.close();
    recorder.close();
  }
});

function session(seed?: string) {
  const ralphRoot = mkdtempSync(resolve(tmpdir(), 'ralph-plan-'));
  const recorder = new PlanRecorder(ralphRoot, { mode: 'new', by: 'daemon' });
  const controller = new AbortController();
  let stopped = 0;
  const io = new FileInterviewIO(recorder, {
    signal: controller.signal,
    onStop: () => {
      stopped += 1;
      controller.abort();
    },
    pollMs: 5,
    ...(seed !== undefined ? { seed } : {}),
  });
  open.push({ io, recorder });
  const state = () => readPlanState(ralphRoot, recorder.id)!;
  return { ralphRoot, recorder, io, controller, state, stopped: () => stopped };
}

/** The error a call throws, for its code. */
function failure(call: () => void): PlanRequestError {
  try {
    call();
  } catch (cause) {
    return cause as PlanRequestError;
  }
  throw new Error('expected it to throw');
}

describe('the file-backed interview IO', () => {
  it('waits for the reply to the question asked, by its number', async () => {
    const { ralphRoot, recorder, io, state } = session();
    const answer = io.ask('Describe the project');
    await until(() => state().status === 'asking');
    expect(state()).toMatchObject({ seq: 1, prompt: 'Describe the project' });
    expect(livePlan(ralphRoot)?.id).toBe(recorder.id);

    expect(failure(() => writePlanReply(ralphRoot, recorder.id, { seq: 2, text: 'too soon' }, 'ui')).code).toBe('conflict');
    expect(failure(() => writePlanReply(ralphRoot, recorder.id, { seq: 1, text: '  ' }, 'ui')).code).toBe('invalid');
    writePlanReply(ralphRoot, recorder.id, { seq: 1, text: 'A todo app.' }, 'ui');
    // Only the first reply stands.
    expect(failure(() => writePlanReply(ralphRoot, recorder.id, { seq: 1, text: 'Another.' }, 'ui')).code).toBe('conflict');

    expect(await answer).toBe('A todo app.');
    expect(state()).toMatchObject({ status: 'working', prompt: null });
    expect(readConversation(ralphRoot, recorder.id).map(({ role, text }) => [role, text])).toEqual([['owner', 'A todo app.']]);

    // The next question takes a new reply; the old one does not answer it.
    const next = io.ask('you');
    await until(() => state().seq === 2);
    expect(failure(() => writePlanReply(ralphRoot, recorder.id, { seq: 1, text: 'stale' }, 'ui')).code).toBe('conflict');
    writePlanReply(ralphRoot, recorder.id, { seq: 2, done: true }, 'ui');
    expect(await next).toBe('/done');
  });

  it('records what the agent and Ralph say, and the latest activity', async () => {
    const { ralphRoot, recorder, io, state } = session();
    io.turn(1);
    io.say('Which stack?');
    io.note('The plan has 1 problem(s)');
    io.status('read .ralph/PRD.md');
    await until(() => state().activity === 'read .ralph/PRD.md');
    expect(state()).toMatchObject({ status: 'working', turn: 1 });
    expect(readConversation(ralphRoot, recorder.id).map((line) => line.role)).toEqual(['agent', 'ralph']);
  });

  it('answers the first question with the description it was given', async () => {
    const { ralphRoot, recorder, io, state } = session('A todo app.');
    expect(await io.ask('Describe the project')).toBe('A todo app.');
    expect(state()).toMatchObject({ seq: 0, status: 'starting' });
    expect(readConversation(ralphRoot, recorder.id).map((line) => line.text)).toEqual(['A todo app.']);
  });

  it('stops when asked, whether asking or at work', async () => {
    const { ralphRoot, recorder, io, state, stopped } = session();
    const answer = io.ask('you');
    await until(() => state().status === 'asking');
    requestPlanStop(ralphRoot, recorder.id, 'ui');
    expect(await answer).toBeNull();
    expect(stopped()).toBe(1);

    const working = session();
    working.io.turn(1);
    requestPlanStop(working.ralphRoot, working.recorder.id, 'ui');
    await until(() => working.controller.signal.aborted);
  });

  it('takes no reply or stop once the session has ended', () => {
    const { ralphRoot, recorder } = session();
    recorder.fail('the server went away');
    expect(failure(() => writePlanReply(ralphRoot, recorder.id, { seq: 0, text: 'hi' }, 'ui')).code).toBe('conflict');
    expect(failure(() => requestPlanStop(ralphRoot, recorder.id, 'ui')).message).toBe('That planning session has ended');
    expect(failure(() => requestPlanStop(ralphRoot, 'nope', 'ui')).code).toBe('conflict');
    expect(livePlan(ralphRoot)).toBeUndefined();
  });
});
