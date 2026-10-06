import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RalphProject } from '../src/ui/project.js';
import { costEstimator, energyEstimator } from '../src/metrics/cost.js';
import { emptyUsage } from '../src/metrics/usage.js';

const LOCAL = '20261001-090000';
const REMOTE = '20260930-090000';
const BIG = 'ollama/big';
const SMALL = 'ollama/small';

const lines = (...values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join('');
const usage = (patch: Partial<ReturnType<typeof emptyUsage>>) => ({ ...emptyUsage(), steps: 1, ...patch });
const iteration = (n: number, taskId: string, extra: Record<string, unknown>) => ({
  iteration: n,
  taskId,
  result: { status: 'progressed', durationMs: 120_000, usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cost: 0 } },
  delta: { productive: true, committed: true, tasksPassedDelta: 0 },
  startedAt: `2026-10-01T0${n}:00:00.000Z`,
  endedAt: `2026-10-01T0${n}:02:00.000Z`,
  ...extra,
});

/**
 * A project with a run here and one known only from its journal: a recorded
 * iteration, one from before usage was recorded with its event file, a split
 * of T-2 into T-2a and T-2b, an assessment with nothing recorded, and a
 * journal-only iteration with only its totals.
 */
function project(): RalphProject {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-metrics-'));
  const ralph = resolve(root, '.ralph');
  const local = resolve(ralph, 'history', LOCAL);
  const remote = resolve(ralph, 'journal', REMOTE);
  mkdirSync(local, { recursive: true });
  mkdirSync(remote, { recursive: true });
  writeFileSync(
    resolve(ralph, 'tasks.json'),
    JSON.stringify([
      { id: 'T-1', title: 'One', passes: true },
      { id: 'T-2a', title: 'Two, first half', passes: true, splitFrom: 'T-2', splitDepth: 1 },
      { id: 'T-2b', title: 'Two, second half', passes: false, splitFrom: 'T-2', splitDepth: 1 },
      { id: 'T-3', title: 'Three', passes: false },
    ]),
  );

  writeFileSync(resolve(local, 'state.json'), JSON.stringify({ runId: LOCAL, status: 'complete', startedAt: '2026-10-01T01:00:00.000Z' }));
  writeFileSync(
    resolve(local, 'iterations.jsonl'),
    lines(
      iteration(1, 'T-1', { models: { [BIG]: usage({ input: 1000, output: 100, inferenceMs: 3_600_000 }) } }),
      iteration(2, 'T-2', {}),
      iteration(3, 'T-2a', { models: { [BIG]: usage({ input: 500, output: 50, inferenceMs: 1_800_000 }) } }),
      iteration(4, 'T-2b', { models: { [SMALL]: usage({ input: 10, output: 10, inferenceMs: 3_600_000 }) } }),
    ),
  );
  writeFileSync(
    resolve(local, 'iteration-002.events.jsonl'),
    lines(
      { type: 'session.step.started', created: 0, data: { sessionID: 's', model: { id: 'big', providerID: 'ollama' } } },
      { type: 'session.step.ended', created: 600_000, data: { sessionID: 's', tokens: { input: 200, output: 20 } } },
    ),
  );
  writeFileSync(
    resolve(local, 'splits.jsonl'),
    lines(
      {
        iteration: 2,
        taskId: 'T-2',
        causes: ['timeout'],
        trigger: 'stall',
        status: 'applied',
        children: ['T-2a', 'T-2b'],
        models: { [SMALL]: usage({ input: 40, output: 4, inferenceMs: 60_000 }) },
        startedAt: '2026-10-01T02:03:00.000Z',
        endedAt: '2026-10-01T02:04:00.000Z',
      },
      { iteration: 5, taskId: 'T-3', causes: [], trigger: 'assessment', status: 'fits', estimateMinutes: 5, startedAt: '2026-10-01T05:00:00.000Z', endedAt: '2026-10-01T05:00:30.000Z' },
    ),
  );

  writeFileSync(resolve(remote, 'state.json'), JSON.stringify({ runId: REMOTE, status: 'stopped', startedAt: '2026-09-30T09:00:00.000Z' }));
  writeFileSync(
    resolve(remote, 'iterations.jsonl'),
    lines({ ...iteration(1, 'T-1', {}), startedAt: '2026-09-30T09:00:00.000Z', result: { status: 'progressed', durationMs: 900_000, usage: { input: 70, output: 7, reasoning: 0, cacheRead: 3, cost: 0.5 } } }),
  );
  return new RalphProject(root, '.ralph');
}

const power = costEstimator({ estimator: 'power', currency: 'EUR', power: { watts: 1000, pricePerKwh: 1, models: { [SMALL]: { watts: 100 } } } });

describe('RalphProject.metrics', () => {
  it('totals every turn of every run, backfilling and approximating the old ones', () => {
    const metrics = project().metrics({ estimator: undefined, currency: 'USD' });
    expect(metrics.coverage).toEqual({ recorded: 4, events: 1, legacy: 1, none: 1 });
    expect(metrics.totals).toMatchObject({
      runs: 2,
      iterations: 5,
      planningTurns: 2,
      input: 1000 + 200 + 500 + 10 + 40 + 70,
      inferenceMs: 3_600_000 + 600_000 + 1_800_000 + 3_600_000 + 60_000 + 900_000,
      reportedCost: 0.5,
      estimatedCost: null,
      energyKwh: null,
    });
    expect(metrics.models.map((model) => [model.model, model.turns])).toEqual([
      [BIG, 3],
      ['unknown', 1],
      [SMALL, 2],
    ]);
    expect(metrics.runs.map((run) => [run.runId, run.iterations, run.planningTurns])).toEqual([
      [LOCAL, 4, 2],
      [REMOTE, 1, 0],
    ]);
    const kinds = metrics.turns.map((turn) => `${turn.kind}:${turn.taskId}:${turn.source}`);
    expect(kinds).toEqual([
      'iteration:T-1:legacy',
      'iteration:T-1:recorded',
      'iteration:T-2:events',
      'split:T-2:recorded',
      'iteration:T-2a:recorded',
      'iteration:T-2b:recorded',
      'assessment:T-3:none',
    ]);
    expect(metrics.cost).toEqual({ estimator: null, currency: 'USD', basis: null });
    expect(metrics.energy).toEqual({ basis: null });
  });

  it('rolls a split task up from the tasks it was split into, listing it before them', () => {
    const { tasks } = project().metrics({ estimator: undefined, currency: 'USD' });
    expect(tasks.map((task) => [task.id, task.parent, task.passes])).toEqual([
      ['T-1', null, true],
      ['T-2', null, null],
      ['T-2a', 'T-2', true],
      ['T-2b', 'T-2', false],
      ['T-3', null, false],
    ]);
    const split = tasks.find((task) => task.id === 'T-2')!;
    expect(split).toMatchObject({ title: null, children: ['T-2a', 'T-2b'], iterations: 1, planningTurns: 1, input: 240 });
    expect(split.total).toMatchObject({ iterations: 3, planningTurns: 1, input: 240 + 500 + 10 });
    expect(tasks.find((task) => task.id === 'T-1')!.total.iterations).toBe(2);
  });

  it('estimates power cost per model on inference time', () => {
    const metrics = project().metrics({ estimator: power, currency: 'EUR' });
    const big = metrics.models.find((model) => model.model === BIG)!;
    // 1 h + 10 min + 30 min at 1 kW and 1 EUR/kWh.
    expect(big.estimatedCost).toBeCloseTo(1 + 1 / 6 + 0.5);
    const small = metrics.models.find((model) => model.model === SMALL)!;
    expect(small.estimatedCost).toBeCloseTo((1 + 1 / 60) * 0.1);
    // The journal-only iteration: 15 min of wall-clock at the default draw.
    expect(metrics.models.find((model) => model.model === 'unknown')!.estimatedCost).toBeCloseTo(0.25);
    expect(metrics.cost).toMatchObject({ estimator: 'power', currency: 'EUR' });
    expect(metrics.totals.estimatedCost).toBeCloseTo(big.estimatedCost! + small.estimatedCost! + 0.25);
  });

  it('measures energy on inference time, with or without a price', () => {
    const draw = energyEstimator({ estimator: 'power', currency: 'EUR', power: { watts: 1000, models: { [SMALL]: { watts: 100 } } } });
    const metrics = project().metrics({ estimator: undefined, energy: draw, currency: 'EUR' });
    expect(metrics.energy.basis).toBe('1000 W (1 model set apart) × inference time');
    expect(metrics.totals.estimatedCost).toBeNull();
    const big = metrics.models.find((model) => model.model === BIG)!;
    // 1 h + 10 min + 30 min at 1 kW.
    expect(big.energyKwh).toBeCloseTo(1 + 1 / 6 + 0.5);
    const small = metrics.models.find((model) => model.model === SMALL)!;
    expect(small.energyKwh).toBeCloseTo((1 + 1 / 60) * 0.1);
    expect(metrics.totals.energyKwh).toBeCloseTo(big.energyKwh! + small.energyKwh! + 0.25);
    const split = metrics.tasks.find((task) => task.id === 'T-2')!;
    expect(split.total.energyKwh).toBeGreaterThan(split.energyKwh!);
    expect(metrics.turns.reduce((sum, turn) => sum + turn.energyKwh!, 0)).toBeCloseTo(metrics.totals.energyKwh!);
  });
});
