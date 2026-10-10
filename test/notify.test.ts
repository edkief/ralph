import { describe, expect, it } from 'vitest';
import { detect, type Seen } from '../src/ui/notify.js';
import type { AskView, IterationView, PendingView, PlanSummary, RunDetail, RunView, StatusView, TaskView } from '../src/ui/types.js';

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

function status(patch: { run?: RunView | null; pending?: PendingView | null; tasks?: TaskView[]; plan?: PlanSummary | null; asks?: AskView[] } = {}): StatusView {
  const items = patch.tasks ?? [task('TASK-1', true), task('TASK-2', false), task('TASK-3', false)];
  return {
    project: 'shop',
    projectRoot: '/work/shop',
    ralphDir: '.ralph',
    tasks: { total: items.length, passed: items.filter((each) => each.passes).length, next: null, items },
    run: patch.run === undefined ? run() : patch.run,
    pending: patch.pending ?? null,
    asks: patch.asks ?? [],
    daemon: null,
    plan: patch.plan ?? null,
    planState: 'written',
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
    expect(first.seen).toEqual({ pending: `${RUN}-1`, runEnded: RUN, iteration: { runId: RUN, n: 1 }, passed: ['TASK-1'], plan: null, asks: [] });
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

describe('the planner asking', () => {
  const plan = (patch: Partial<PlanSummary> = {}): PlanSummary => ({
    id: '20261007-120000',
    mode: 'new',
    by: 'daemon',
    status: 'asking',
    live: true,
    seq: 1,
    prompt: 'you',
    activity: null,
    turn: 1,
    maxTurns: 30,
    model: null,
    startedAt: '2026-10-07T12:00:00.000Z',
    ...patch,
  });
  const quiet = (view: Partial<Parameters<typeof status>[0]> = {}) => status({ run: null, ...view });

  it('tells each question once, as a request', () => {
    const before = detect(null, quiet(), null).seen;
    const asked = detect(before, quiet({ plan: plan() }), null);
    expect(asked.notifications).toEqual([
      { event: 'request', payload: { title: 'shop: Ralph needs you', body: 'The planner has a question', tag: 'plan-20261007-120000', path: '#/plan' } },
    ]);
    expect(detect(asked.seen, quiet({ plan: plan() }), null).notifications).toEqual([]);
    // Working on the reply, then the next question.
    const working = detect(asked.seen, quiet({ plan: plan({ status: 'working', prompt: null }) }), null);
    expect(working.notifications).toEqual([]);
    expect(detect(working.seen, quiet({ plan: plan({ seq: 2 }) }), null).notifications).toHaveLength(1);
  });

  it('says nothing of a question asked in a terminal, or of one asked before', () => {
    expect(detect(detect(null, quiet(), null).seen, quiet({ plan: plan({ by: 'cli' }) }), null).notifications).toEqual([]);
    const start = detect(null, quiet({ plan: plan() }), null);
    expect(start.notifications).toEqual([]);
    expect(detect(start.seen, quiet({ plan: plan() }), null).notifications).toEqual([]);
  });

  it('reads a watermark written before planning was', () => {
    const old: Seen = { pending: null, runEnded: null, iteration: null, passed: ['TASK-1'] };
    expect(detect(old, quiet({ plan: plan() }), null).notifications).toHaveLength(1);
  });
  describe('asks', () => {
    const ask = (id: string, patch: Partial<AskView> = {}): AskView => ({
      id,
      kind: 'form',
      origin: 'run',
      runId: RUN,
      taskId: 'TASK-2',
      form: { title: 'Questions', source: 'question', fields: [{ key: 'db', type: 'string', title: 'Which database?' }] },
      answered: false,
      createdAt: '2026-10-10T00:00:00.000Z',
      ...patch,
    });

    it('tells each new form or permission once, and not one answered', () => {
      const first = detect(now(), status({ asks: [ask('frm_1'), ask('per_1', { kind: 'permission', form: undefined, permission: { action: 'shell', resources: ['make deploy'] } })] }), null);
      expect(first.notifications.map((each) => each.payload)).toEqual([
        { title: 'shop: Ralph needs you', body: 'The agent asks on TASK-2: Which database?', tag: 'ask-frm_1', path: '#/overview' },
        { title: 'shop: Ralph needs you', body: 'The agent asks permission on TASK-2: shell make deploy', tag: 'ask-per_1', path: '#/overview' },
      ]);
      expect(first.notifications.every((each) => each.event === 'request')).toBe(true);
      expect(detect(first.seen, status({ asks: [ask('frm_1'), ask('per_1')] }), null).notifications).toEqual([]);
      expect(detect(now(), status({ asks: [ask('frm_2', { answered: true })] }), null).notifications).toEqual([]);
    });

    it("sends a planner's form to the Plan tab", () => {
      const told = detect(now(), status({ asks: [ask('frm_1', { origin: 'plan', planId: 'p1', taskId: null, form: { title: 'Stack', source: 'mcp', fields: [] } })] }), null);
      expect(told.notifications[0]?.payload).toMatchObject({ body: 'An MCP server asks while planning: Stack', path: '#/plan' });
    });

    it('takes a store from before asks for having told none', () => {
      const { asks: _asks, ...old } = now();
      expect(detect(old, status({ asks: [ask('frm_1')] }), null).notifications).toHaveLength(1);
    });
  });
});
