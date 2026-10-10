export type WatchdogTrip = 'inactivity' | 'iteration-timeout' | 'retry-storm' | 'wrap-up-timeout';

export interface WatchdogOptions {
  iterationMs: number;
  inactivityMs: number;
  maxProviderRetries: number;
  /** Budget for the wrap-up turn, counted from `beginWrapUp()`. */
  wrapUpMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Detects the three ways an iteration dies quietly.
 *
 * The one that bit the bash loop hardest is `retry-storm`: when the model
 * provider is unreachable, opencode retries with backoff and emits no text,
 * no error and never exits — the loop just hangs or spins forever.
 *
 * Once the agent is asked to wrap up, the iteration budget no longer applies:
 * the wrap-up budget does, and inactivity and retry storms still trip.
 *
 * While opencode compacts the conversation it sends nothing until the summary
 * is done, which on a slow local model can outlast the inactivity window.
 * Inactivity is not checked then; the time budgets still are.
 *
 * While the agent waits on a person (a form to fill in, a permission to
 * grant), nothing trips but a retry storm, and the time spent waiting does not
 * count against the budgets.
 */
export class Watchdog {
  private startedAt: number;
  private lastActivityAt: number;
  private wrapUpStartedAt: number | null = null;
  private compacting = false;
  private retries = 0;
  private holds = 0;
  private heldSince: number | null = null;
  private readonly now: () => number;

  constructor(private readonly options: WatchdogOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
  }

  /** Called for any event proving the agent is making progress. */
  recordActivity(): void {
    this.lastActivityAt = this.now();
    this.retries = 0;
    this.compacting = false;
  }

  /**
   * Called when compaction starts. Any later activity ends it: a compaction
   * that fails sends no end event, and the turn carries on without it.
   */
  beginCompaction(): void {
    this.compacting = true;
  }

  /** Called on `session.retry.scheduled`. */
  recordProviderRetry(): void {
    this.retries += 1;
  }

  get providerRetries(): number {
    return this.retries;
  }

  get wrappingUp(): boolean {
    return this.wrapUpStartedAt !== null;
  }

  get held(): boolean {
    return this.holds > 0;
  }

  /** The agent waits on a person from now: stop the clocks. Calls nest. */
  hold(): void {
    if (this.holds === 0) this.heldSince = this.now();
    this.holds += 1;
  }

  /** One wait is over; once all are, the clocks run again, without the time held. */
  release(): void {
    if (this.holds === 0) return;
    this.holds -= 1;
    if (this.holds > 0 || this.heldSince === null) return;
    const now = this.now();
    const held = now - this.heldSince;
    this.heldSince = null;
    this.startedAt += held;
    if (this.wrapUpStartedAt !== null) this.wrapUpStartedAt += held;
    this.lastActivityAt = now;
  }

  /** Switch to the wrap-up budget, with a fresh inactivity window. */
  beginWrapUp(): void {
    this.wrapUpStartedAt = this.now();
    this.lastActivityAt = this.wrapUpStartedAt;
  }

  /** The reason to abort this iteration, or null to keep waiting. */
  check(): WatchdogTrip | null {
    const now = this.now();
    if (this.retries > this.options.maxProviderRetries) return 'retry-storm';
    if (this.holds > 0) return null;
    if (this.wrapUpStartedAt !== null) {
      if (now - this.wrapUpStartedAt >= (this.options.wrapUpMs ?? 0)) return 'wrap-up-timeout';
    } else if (now - this.startedAt >= this.options.iterationMs) {
      return 'iteration-timeout';
    }
    if (!this.compacting && now - this.lastActivityAt >= this.options.inactivityMs) return 'inactivity';
    return null;
  }

  /** Milliseconds until the next check could trip, for scheduling a timer. */
  nextCheckDelay(): number {
    const now = this.now();
    const budgetLeft =
      this.wrapUpStartedAt !== null
        ? (this.options.wrapUpMs ?? 0) - (now - this.wrapUpStartedAt)
        : this.options.iterationMs - (now - this.startedAt);
    const quietLeft = this.compacting ? budgetLeft : this.options.inactivityMs - (now - this.lastActivityAt);
    return Math.max(250, Math.min(budgetLeft, quietLeft));
  }
}

export function describeTrip(trip: WatchdogTrip, options: WatchdogOptions): string {
  switch (trip) {
    case 'inactivity':
      return `No activity from the agent for ${Math.round(options.inactivityMs / 1000)}s`;
    case 'iteration-timeout':
      return `Iteration exceeded its ${formatBudget(options.iterationMs)} budget`;
    case 'retry-storm':
      return `Provider retried more than ${options.maxProviderRetries} times without progress`;
    case 'wrap-up-timeout':
      return `Wrap-up exceeded its ${formatBudget(options.wrapUpMs ?? 0)} budget`;
  }
}

/** `45m`, `90s` or `1m30s`: whole minutes when the budget is in minutes. */
function formatBudget(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}m${rest === 0 ? '' : `${String(rest).padStart(2, '0')}s`}`;
}
