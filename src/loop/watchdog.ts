export type WatchdogTrip = 'inactivity' | 'iteration-timeout' | 'retry-storm';

export interface WatchdogOptions {
  iterationMs: number;
  inactivityMs: number;
  maxProviderRetries: number;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Detects the three ways an iteration dies quietly.
 *
 * The one that bit the bash loop hardest is `retry-storm`: when the model
 * provider is unreachable, opencode retries with backoff and emits no text,
 * no error and never exits — the loop just hangs or spins forever.
 */
export class Watchdog {
  private readonly startedAt: number;
  private lastActivityAt: number;
  private retries = 0;
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
  }

  /** Called on `session.retry.scheduled`. */
  recordProviderRetry(): void {
    this.retries += 1;
  }

  get providerRetries(): number {
    return this.retries;
  }

  /** The reason to abort this iteration, or null to keep waiting. */
  check(): WatchdogTrip | null {
    const now = this.now();
    if (this.retries > this.options.maxProviderRetries) return 'retry-storm';
    if (now - this.startedAt >= this.options.iterationMs) return 'iteration-timeout';
    if (now - this.lastActivityAt >= this.options.inactivityMs) return 'inactivity';
    return null;
  }

  /** Milliseconds until the next check could trip, for scheduling a timer. */
  nextCheckDelay(): number {
    const now = this.now();
    return Math.max(
      250,
      Math.min(
        this.options.iterationMs - (now - this.startedAt),
        this.options.inactivityMs - (now - this.lastActivityAt),
      ),
    );
  }
}

export function describeTrip(trip: WatchdogTrip, options: WatchdogOptions): string {
  switch (trip) {
    case 'inactivity':
      return `No activity from the agent for ${Math.round(options.inactivityMs / 1000)}s`;
    case 'iteration-timeout':
      return `Iteration exceeded its ${Math.round(options.iterationMs / 60_000)}m budget`;
    case 'retry-storm':
      return `Provider retried more than ${options.maxProviderRetries} times without progress`;
  }
}
