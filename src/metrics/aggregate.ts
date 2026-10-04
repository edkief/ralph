import type { MetricsModel, MetricsRun, MetricsTask, MetricsTurn, MetricsUsage, MetricsView } from '../ui/types.js';
import type { CostEstimator } from './cost.js';
import { totalTokens, type ModelUsage, type TurnUsage } from './usage.js';

/** A turn as read from a run's records, its usage worked out. */
export interface TurnInput {
  runId: string;
  kind: MetricsTurn['kind'];
  iteration: number;
  taskId: string | null;
  startedAt: string | null;
  wallMs: number | null;
  usage: TurnUsage;
  source: MetricsTurn['source'];
}

export interface RunInput {
  runId: string;
  status: string;
  startedAt: string | null;
}

/** A task in tasks.json, in backlog order. */
export interface TaskInput {
  id: string;
  title: string;
  passes: boolean;
  splitFrom?: string;
}

export function emptyMetrics(estimator: CostEstimator | undefined): MetricsUsage {
  return {
    steps: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    inferenceMs: 0,
    reportedCost: 0,
    estimatedCost: estimator ? 0 : null,
  };
}

function addMetrics<T extends MetricsUsage>(into: T, from: MetricsUsage): T {
  into.steps += from.steps;
  into.input += from.input;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.tokens += from.tokens;
  into.inferenceMs += from.inferenceMs;
  into.reportedCost += from.reportedCost;
  if (into.estimatedCost !== null && from.estimatedCost !== null) into.estimatedCost += from.estimatedCost;
  return into;
}

function modelMetrics(model: string, usage: ModelUsage, estimator: CostEstimator | undefined): MetricsUsage {
  return {
    steps: usage.steps,
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    tokens: totalTokens(usage),
    inferenceMs: usage.inferenceMs,
    reportedCost: usage.cost,
    estimatedCost: estimator ? (estimator.estimate(model, usage) ?? 0) : null,
  };
}

/**
 * The project's metrics from every turn of every run: totals, and the same
 * broken down by model, run and task. A task split into others carries their
 * figures in its `total`, so the cost of a task shows whole however it was cut up.
 * Costs are estimated here, as they are read, so a changed price re-prices all of it.
 */
export function aggregateMetrics(args: {
  runs: RunInput[];
  turns: TurnInput[];
  tasks: TaskInput[];
  /** Applied splits: the task split, and the tasks it was split into. */
  splits: Array<{ taskId: string; children: string[] }>;
  estimator: CostEstimator | undefined;
  currency: string;
}): MetricsView {
  const { estimator } = args;
  const totals = { ...emptyMetrics(estimator), runs: args.runs.length, iterations: 0, planningTurns: 0, wallMs: 0 };
  const models = new Map<string, MetricsModel>();
  const runs = new Map<string, MetricsRun>(
    args.runs.map((run) => [
      run.runId,
      { ...emptyMetrics(estimator), runId: run.runId, status: run.status, startedAt: run.startedAt, iterations: 0, planningTurns: 0, wallMs: 0 },
    ]),
  );
  const ownByTask = new Map<string, MetricsUsage & { iterations: number; planningTurns: number }>();
  const coverage: MetricsView['coverage'] = { recorded: 0, events: 0, legacy: 0, none: 0 };

  const turns: MetricsTurn[] = [];
  for (const input of args.turns) {
    const turn: MetricsTurn = {
      ...emptyMetrics(estimator),
      runId: input.runId,
      kind: input.kind,
      iteration: input.iteration,
      taskId: input.taskId,
      startedAt: input.startedAt,
      wallMs: input.wallMs,
      models: Object.keys(input.usage),
      source: input.source,
    };
    for (const [model, usage] of Object.entries(input.usage)) {
      const metrics = modelMetrics(model, usage, estimator);
      addMetrics(turn, metrics);
      const entry = models.get(model) ?? { ...emptyMetrics(estimator), model, turns: 0 };
      addMetrics(entry, metrics).turns += 1;
      models.set(model, entry);
    }
    turns.push(turn);
    coverage[input.source] += 1;

    const iterations = input.kind === 'iteration' ? 1 : 0;
    addMetrics(totals, turn);
    totals.iterations += iterations;
    totals.planningTurns += 1 - iterations;
    totals.wallMs += input.wallMs ?? 0;

    const run = runs.get(input.runId);
    if (run) {
      addMetrics(run, turn);
      run.iterations += iterations;
      run.planningTurns += 1 - iterations;
      run.wallMs += input.wallMs ?? 0;
    }
    if (input.taskId) {
      const own = ownByTask.get(input.taskId) ?? { ...emptyMetrics(estimator), iterations: 0, planningTurns: 0 };
      addMetrics(own, turn);
      own.iterations += iterations;
      own.planningTurns += 1 - iterations;
      ownByTask.set(input.taskId, own);
    }
  }
  turns.sort((a, b) => time(a.startedAt) - time(b.startedAt));

  return {
    totals,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    runs: [...runs.values()].sort((a, b) => time(b.startedAt) - time(a.startedAt) || (a.runId < b.runId ? 1 : -1)),
    tasks: taskTree(args.tasks, args.splits, ownByTask, estimator),
    turns,
    cost: { estimator: estimator?.id ?? null, currency: args.currency, basis: estimator?.basis ?? null },
    coverage,
  };
}

/**
 * Every task with figures or in the backlog, with its own figures and those
 * rolled up from the tasks split from it. A task that was split is gone from
 * tasks.json; it is brought back, from the split records and the `splitFrom`
 * of the tasks that replaced it, just before the first of them.
 */
function taskTree(
  backlog: TaskInput[],
  splits: Array<{ taskId: string; children: string[] }>,
  own: Map<string, MetricsUsage & { iterations: number; planningTurns: number }>,
  estimator: CostEstimator | undefined,
): MetricsTask[] {
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const link = (parent: string, child: string) => {
    if (parent === child || parentOf.has(child)) return;
    parentOf.set(child, parent);
    const children = childrenOf.get(parent) ?? [];
    children.push(child);
    childrenOf.set(parent, children);
  };
  for (const task of backlog) if (task.splitFrom) link(task.splitFrom, task.id);
  for (const split of splits) for (const child of split.children) link(split.taskId, child);

  const listed = new Map(backlog.map((task) => [task.id, task]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const place = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const parent = parentOf.get(id);
    if (parent && !listed.has(parent)) place(parent);
    ids.push(id);
  };
  for (const task of backlog) place(task.id);
  for (const id of [...own.keys(), ...childrenOf.keys()]) place(id);

  const totals = new Map<string, MetricsTask['total']>();
  const totalOf = (id: string, path: Set<string>): MetricsTask['total'] => {
    const known = totals.get(id);
    if (known) return known;
    const total = { ...emptyMetrics(estimator), iterations: 0, planningTurns: 0 };
    const mine = own.get(id);
    if (mine) {
      addMetrics(total, mine);
      total.iterations += mine.iterations;
      total.planningTurns += mine.planningTurns;
    }
    path.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      if (path.has(child)) continue;
      const theirs = totalOf(child, path);
      addMetrics(total, theirs);
      total.iterations += theirs.iterations;
      total.planningTurns += theirs.planningTurns;
    }
    path.delete(id);
    totals.set(id, total);
    return total;
  };

  return ids.map((id) => {
    const task = listed.get(id);
    const mine = own.get(id) ?? { ...emptyMetrics(estimator), iterations: 0, planningTurns: 0 };
    return {
      ...mine,
      id,
      title: task?.title ?? null,
      passes: task ? task.passes : null,
      parent: parentOf.get(id) ?? null,
      children: childrenOf.get(id) ?? [],
      total: totalOf(id, new Set()),
    };
  });
}

function time(value: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
