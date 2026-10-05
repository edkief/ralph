import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPushStore, pushPath, sendPush, subscribe, unsubscribe, type PushSender } from '../src/ui/push.js';
import { Logger } from '../src/report/logger.js';

const lines: string[] = [];
const logger = new Logger({ level: 'info', format: 'json', stream: { write: (line: string) => lines.push(line) } as unknown as NodeJS.WriteStream });

const browser = (n: number) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: `key-${n}`, auth: `auth-${n}` } });
const payload = { title: 'shop: Ralph needs you', body: 'A decision', tag: 'request-1', path: '#/overview' };

function ralphRoot(): string {
  return resolve(mkdtempSync(resolve(tmpdir(), 'ralph-push-')), '.ralph');
}

describe('push subscriptions', () => {
  it('makes a key pair once and keeps it out of git, beside the runs', () => {
    const root = ralphRoot();
    const first = loadPushStore(root);
    expect(first.vapid.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(loadPushStore(root).vapid).toEqual(first.vapid);
    expect(pushPath(root)).toBe(resolve(root, 'history', 'push.json'));
    expect(JSON.parse(readFileSync(pushPath(root), 'utf8')).vapid.privateKey).toBe(first.vapid.privateKey);
  });

  it('keeps one subscription per browser, with the events it chose', () => {
    const root = ralphRoot();
    subscribe(root, browser(1));
    subscribe(root, browser(2), ['task', 'request']);
    expect(loadPushStore(root).subscriptions.map(({ endpoint, events }) => ({ endpoint, events }))).toEqual([
      { endpoint: browser(1).endpoint, events: ['request', 'run-end'] },
      { endpoint: browser(2).endpoint, events: ['request', 'task'] },
    ]);
    const createdAt = loadPushStore(root).subscriptions[0]!.createdAt;
    subscribe(root, browser(1), ['iteration']);
    const [, again] = loadPushStore(root).subscriptions;
    expect(again).toMatchObject({ endpoint: browser(1).endpoint, events: ['iteration'], createdAt });
    expect(loadPushStore(root).subscriptions).toHaveLength(2);

    expect(unsubscribe(root, browser(1).endpoint)).toBe(true);
    expect(unsubscribe(root, browser(1).endpoint)).toBe(false);
    expect(loadPushStore(root).subscriptions).toHaveLength(1);
  });

  it('sends to the browsers that want the event, and forgets the ones that are gone', async () => {
    const root = ralphRoot();
    subscribe(root, browser(1));
    subscribe(root, browser(2));
    subscribe(root, browser(3), ['task']);
    subscribe(root, browser(4));
    const sent: Array<{ endpoint: string; body: unknown; urgency: string; subject: string }> = [];
    const sender: PushSender = async (subscription, body, options) => {
      if (subscription.endpoint === browser(2).endpoint) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      if (subscription.endpoint === browser(4).endpoint) throw Object.assign(new Error('Too many requests'), { statusCode: 429 });
      sent.push({ endpoint: subscription.endpoint, body: JSON.parse(body), urgency: options.urgency, subject: options.subject });
    };

    lines.length = 0;
    const delivered = await sendPush({ ralphRoot: root, event: 'request', payload, subject: 'mailto:me@example.com', sender, logger });
    expect(delivered).toBe(1);
    expect(sent).toEqual([{ endpoint: browser(1).endpoint, body: payload, urgency: 'high', subject: 'mailto:me@example.com' }]);
    expect(loadPushStore(root).subscriptions.map((each) => each.endpoint)).toEqual([1, 3, 4].map((n) => browser(n).endpoint));
    expect(lines.join('')).toContain('Too many requests');

    sent.length = 0;
    await sendPush({ ralphRoot: root, event: null, endpoint: browser(3).endpoint, payload, subject: 'mailto:me@example.com', sender, logger });
    expect(sent.map((each) => [each.endpoint, each.urgency])).toEqual([[browser(3).endpoint, 'normal']]);
  });
});
