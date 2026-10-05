import { describe, expect, it } from 'vitest';
import { detect, type Seen } from '../src/ui/notify.js';
import type { IterationView, PendingView, RunDetail, RunView, StatusView, TaskView } from '../src/ui/types.js';

const RUN = '20261005-100000';

const run = (patch: Partial<RunView> = {}): RunView => ({
  runId: RUN,
  status: 'running',
  live: true,
  startedAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:10:00.000Z',
  maxIterations: 10,
  iteration: 2,
  taskId: 'TASK-2',
  iterationStartedAt: '2026-10-05T10:10:00.000Z',
  lastStatus: 'progressed',
  tasksPassed: 1,
  tasksTotal: 3,
  split: null,
  escalation: null,
  ...patch,
});

const task = (id: string, passes: boolean): TaskView => ({ id, title: `Do ${id}`, passes });

function status(patch: { run?: RunView | null; pending?: PendingView | null; tasks?: TaskView[] } = {}): StatusView {
  const items = patch.tasks ?? [task('TASK-1', true), task('TASK-2', false), task('TASK-3', false)];
  return {
    project: 'shop',
    projectRoot: '/work/shop',
    ralphDir: '.ralph',
    tasks: { total: items.length, passed: items.filter((each) => each.passes).length, next: null, items },
    run: patch.run === undefined ? run() : patch.run,
    pending: patch.pending ?? null,
    daemon: null,
  };
}

const iteration = (n: number, state = 'progressed'): IterationView => ({
  iteration: n,
  taskId: `TASK-${n}`,
  status: state,
  startedAt: null,
  endedAt: null,
  durationMs: null,
  toolCalls: null,
  tokens: null,
  committed: state === 'progressed',
  tasksPassedDelta: 0,
  compactions: 0,
});

const detail = (iterations: IterationView[], view = run()): RunDetail => ({ run: view, iterations, splits: [], escalations: [] });

const pending = (patch: Partial<PendingView> = {}): PendingView => ({
  id: `${RUN}-1`,
  runId: RUN,
  kind: 'decide',
  taskId: 'TASK-2',
  message: 'REST or GraphQL?',
  question: 'REST or GraphQL?',
  waiting: true,
  answered: false,
  actions: ['answer', 'stop'],
  createdAt: '2026-10-05T10:11:00.000Z',
  ...patch,
});

/** What was seen of the run in progress, one iteration in. */
const now = (): Seen => detect(null, status(), detail([iteration(1), iteration(2, 'running')])).seen;

describe('detecting what to notify', () => {
  it('takes the watermark from the present the first time, and sends nothing', () => {
    const first = detect(null, status({ pending: pending(), run: run({ live: false, status: 'complete' }) }), detail([iteration(1)]));
    expect(first.notifications).toEqual([]);
    expect(first.seen).toEqual({ pending: `${RUN}-1`, runEnded: RUN, iteration: { runId: RUN, n: 1 }, passed: ['TASK-1'] });
  });

  it('tells a person about a new request once', () => {
    const asked = detect(now(), status({ pending: pending(), run: run({ status: 'waiting' }) }), detail([iteration(1), iteration(2, 'running')]));
    expect(asked.notifications).toEqual([
      {
        event: 'request',
        payload: {
          title: 'shop: Ralph needs you',
          body: 'A decision on TASK-2: REST or GraphQL?',
          tag: `request-${RUN}-1`,
          path: '#/overview',
        },
      },
    ]);
    const again = detect(asked.seen, status({ pending: pending(), run: run({ status: 'waiting' }) }), detail([iteration(1)]));
    expect(again.notifications).toEqual([]);
  });

  it('does not tell about a request that was already answered', () => {
    expect(detect(now(), status({ pending: pending({ answered: true }) }), detail([iteration(1)])).notifications).toEqual([]);
  });

  it('tells when the run ends, but not twice when it ended over a request', () => {
    const ended = run({ live: false, status: 'max-iterations', message: 'Ran out of iterations', iteration: 10 });
    const told = detect(now(), status({ run: ended }), detail([iteration(1)], ended));
    expect(told.notifications.map((each) => each.event)).toEqual(['run-end']);
    expect(told.notifications[0]!.payload).toMatchObject({ title: 'shop: the run ended (max iterations)', body: 'Ran out of iterations · 1/3 tasks pass' });
    expect(detect(told.seen, status({ run: ended }), detail([iteration(1)], ended)).notifications).toEqual([]);

    const blocked = run({ live: false, status: 'blocked' });
    const once = detect(now(), status({ run: blocked, pending: pending({ kind: 'blocked', waiting: false }) }), detail([iteration(1)], blocked));
    expect(once.notifications.map((each) => each.event)).toEqual(['request']);

    const complete = run({ live: false, status: 'complete' });
    expect(detect(now(), status({ run: complete }), detail([iteration(1)], complete)).notifications[0]!.payload.title).toBe(
      'shop: the run is complete',
    );
  });

  it('tells when an iteration ends, linking to its transcript', () => {
    const told = detect(now(), status(), detail([iteration(1), iteration(2, 'timeout'), iteration(3, 'running')]));
    expect(told.notifications).toEqual([
      {
        event: 'iteration',
        payload: { title: 'shop: iteration 2 ended', body: 'TASK-2 · timeout · no commit', tag: `iteration-${RUN}-2`, path: `#/transcript/${RUN}/2` },
      },
    ]);
    expect(told.seen.iteration).toEqual({ runId: RUN, n: 2 });

    // A new run's first iteration is news, though its number is lower.
    const next = run({ runId: '20261005-120000' });
    expect(detect(told.seen, status({ run: next }), detail([iteration(1)], next)).notifications.map((each) => each.event)).toEqual(['iteration']);
  });

  it('tells which tasks newly pass, and ignores a tasks file it cannot read', () => {
    const told = detect(now(), status({ tasks: [task('TASK-1', true), task('TASK-2', true), task('TASK-3', true)] }), null);
    expect(told.notifications).toEqual([
      {
        event: 'task',
        payload: { title: 'shop: 2 tasks pass', body: 'TASK-2 Do TASK-2, TASK-3 Do TASK-3 · 3/3 done', tag: 'task-TASK-2', path: '#/tasks' },
      },
    ]);

    const broken = status({ tasks: [] });
    broken.tasks.error = 'tasks.json is not JSON';
    const unread = detect(now(), broken, null);
    expect(unread.notifications).toEqual([]);
    expect(unread.seen.passed).toEqual(['TASK-1']);
  });
});
