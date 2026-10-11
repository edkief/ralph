import type { HarnessEvent } from '../harness/events.js';

/**
 * Where the events of every session meet. A subscription is live as soon as
 * `subscribe` returns, though its generator does no work until it is first
 * read, so events published between the two are kept for it.
 */
export class EventBus {
  private readonly subscribers = new Set<(event: HarnessEvent) => void>();

  publish(event: HarnessEvent): void {
    for (const deliver of this.subscribers) deliver(event);
  }

  subscribe(signal: AbortSignal): AsyncGenerator<HarnessEvent> {
    const queue: HarnessEvent[] = [];
    let wake: (() => void) | undefined;
    const deliver = (event: HarnessEvent) => {
      queue.push(event);
      wake?.();
    };
    const onAbort = () => wake?.();
    this.subscribers.add(deliver);
    signal.addEventListener('abort', onAbort, { once: true });

    const subscribers = this.subscribers;
    return (async function* () {
      try {
        while (!signal.aborted) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            // An event or the abort may have come in since the check above.
            if (queue.length > 0 || signal.aborted) resolve();
          });
          wake = undefined;
        }
      } finally {
        subscribers.delete(deliver);
        signal.removeEventListener('abort', onAbort);
      }
    })();
  }
}
