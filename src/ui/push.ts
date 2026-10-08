import { resolve } from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';
import { readAs, writeAtomic } from '../human/request.js';
import type { Logger } from '../report/logger.js';
import type { Seen } from './notify.js';
import type { PushEvent, PushPayload } from './types.js';

/**
 * Web Push from the web UI's server. The browser subscribes through its push
 * service with this project's VAPID public key; the server keeps the
 * subscription and sends to it, encrypted for that browser alone.
 */

export const PUSH_EVENTS = ['request', 'run-end', 'iteration', 'task'] as const satisfies readonly PushEvent[];
export const DEFAULT_EVENTS: PushEvent[] = ['request', 'run-end'];

const SubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith('https://'),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SubscribeSchema = z.object({
  subscription: SubscriptionSchema,
  events: z.array(z.enum(PUSH_EVENTS)).optional(),
});
export const EndpointSchema = z.object({ endpoint: z.string().min(1) });

const StoreSchema = z.object({
  vapid: z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }),
  subscriptions: z.array(
    SubscriptionSchema.extend({ events: z.array(z.enum(PUSH_EVENTS)), createdAt: z.string() }),
  ),
  seen: z
    .object({
      pending: z.string().nullable(),
      runEnded: z.string().nullable(),
      iteration: z.object({ runId: z.string(), n: z.number() }).nullable(),
      passed: z.array(z.string()),
      plan: z.string().nullable().optional(),
    })
    .nullable(),
});
export type PushStore = z.infer<typeof StoreSchema>;

/**
 * Beside the runs in history/, out of git: the private key must not be
 * committed, and subscriptions belong to the browsers of this machine's UI.
 */
export const pushPath = (ralphRoot: string) => resolve(ralphRoot, 'history', 'push.json');

/** The project's store, with a key pair made the first time. Keys outlive restarts, or every subscription would break. */
export function loadPushStore(ralphRoot: string): PushStore {
  const store = readAs(pushPath(ralphRoot), StoreSchema);
  if (store) return store;
  const fresh: PushStore = { vapid: webpush.generateVAPIDKeys(), subscriptions: [], seen: null };
  writeAtomic(pushPath(ralphRoot), fresh);
  return fresh;
}

export function savePushStore(ralphRoot: string, store: PushStore): void {
  writeAtomic(pushPath(ralphRoot), store);
}

/** Add a browser, or change what an already subscribed one gets. */
export function subscribe(ralphRoot: string, subscription: Subscription, events: PushEvent[] = DEFAULT_EVENTS): void {
  const store = loadPushStore(ralphRoot);
  const others = store.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
  const existing = store.subscriptions.find((entry) => entry.endpoint === subscription.endpoint);
  const wanted = PUSH_EVENTS.filter((event) => events.includes(event));
  others.push({ ...subscription, events: wanted, createdAt: existing?.createdAt ?? new Date().toISOString() });
  savePushStore(ralphRoot, { ...store, subscriptions: others });
}

/** Forget a browser. True when it was subscribed. */
export function unsubscribe(ralphRoot: string, endpoint: string): boolean {
  const store = loadPushStore(ralphRoot);
  const kept = store.subscriptions.filter((entry) => entry.endpoint !== endpoint);
  if (kept.length === store.subscriptions.length) return false;
  savePushStore(ralphRoot, { ...store, subscriptions: kept });
  return true;
}

export function saveSeen(ralphRoot: string, seen: Seen | null): void {
  savePushStore(ralphRoot, { ...loadPushStore(ralphRoot), seen });
}

/** Deliver one payload to one browser. Rejects with the push service's `statusCode` when it refuses. */
export type PushSender = (
  subscription: Subscription,
  payload: string,
  options: { vapid: PushStore['vapid']; subject: string; urgency: 'normal' | 'high' },
) => Promise<void>;

export const webPushSender: PushSender = async (subscription, payload, options) => {
  await webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: options.subject, publicKey: options.vapid.publicKey, privateKey: options.vapid.privateKey },
    // A notification about the state of a run is worth little a day late.
    TTL: 24 * 60 * 60,
    urgency: options.urgency,
  });
};

/**
 * Send `payload` to every browser that wants `event`, or to the one at
 * `endpoint`. A browser its push service says is gone (404, 410) is
 * forgotten; any other failure is logged and the rest are still sent to.
 * Resolves with how many were delivered.
 */
export async function sendPush(args: {
  ralphRoot: string;
  event: PushEvent | null;
  payload: PushPayload;
  subject: string;
  sender: PushSender;
  logger: Logger;
  endpoint?: string;
}): Promise<number> {
  const store = loadPushStore(args.ralphRoot);
  const targets = store.subscriptions.filter((entry) =>
    args.endpoint ? entry.endpoint === args.endpoint : args.event !== null && entry.events.includes(args.event),
  );
  const body = JSON.stringify(args.payload);
  const urgency = args.event === 'request' ? 'high' : 'normal';
  const gone: string[] = [];
  let delivered = 0;
  await Promise.all(
    targets.map(async ({ endpoint, keys }) => {
      try {
        await args.sender({ endpoint, keys }, body, { vapid: store.vapid, subject: args.subject, urgency });
        delivered += 1;
      } catch (cause) {
        const code = (cause as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(endpoint);
        else args.logger.warn('push notification not delivered', { event: args.event ?? 'test', host: hostOf(endpoint), error: (cause as Error).message });
      }
    }),
  );
  for (const endpoint of gone) {
    unsubscribe(args.ralphRoot, endpoint);
    args.logger.info('push subscription gone: forgotten', { host: hostOf(endpoint) });
  }
  return delivered;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '?';
  }
}
