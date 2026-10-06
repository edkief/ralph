import { useEffect, useRef, useState } from 'react';
import { forgetToken, hasToken, postJson, rememberToken, useJson, type PushEvent, type PushView, type StatusView } from '../api';

const EVENT_LABELS: Record<PushEvent, string> = {
  request: 'Ralph needs me',
  'run-end': 'A run ends',
  iteration: 'An iteration ends',
  task: 'A task passes',
};

const EVENTS_KEY = 'ralph-push-events';
/** The panel's width at most, as in styles.css. */
const PANEL_WIDTH = 320;

/** Why this browser cannot get notifications from here, if it cannot. */
function unsupported(): string | null {
  if (!window.isSecureContext) {
    return 'Browsers allow notifications only on https:// or localhost. Serve the UI over HTTPS (e.g. behind a TLS proxy) to get them on this device.';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'This browser has no Web Push. On iPhone and iPad, add Ralph to the home screen (Share → Add to Home Screen) and open it from there.';
  }
  return null;
}

function savedEvents(defaults: PushEvent[]): PushEvent[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(EVENTS_KEY) ?? 'null') as PushEvent[] | null;
    return Array.isArray(saved) ? saved : defaults;
  } catch {
    return defaults;
  }
}

function saveEvents(events: PushEvent[]): void {
  try {
    window.localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    // Remembered for this page only.
  }
}

/** A base64url VAPID key as the bytes `pushManager.subscribe` takes. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, key: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const wanted = keyBytes(key);
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, i) => byte === wanted[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Relative, so its scope is the UI's own path, behind a proxy prefix too.
  await navigator.serviceWorker.register('sw.js');
  return navigator.serviceWorker.ready;
}

/**
 * Turn Web Push notifications on or off for this browser, and pick what they
 * are sent for. The server sends them whether or not a page is open.
 */
export function Notifications({ status }: { status: StatusView | null }) {
  const push = useJson<PushView>('/api/push');
  const [open, setOpen] = useState(false);
  // Opens toward the side with room: rightward when the bell sits too near the left edge.
  const [openRight, setOpenRight] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [events, setEvents] = useState<PushEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  // Once asked for, the token field stays until an action goes through: hiding it
  // as soon as a token is held would take it away at the first character typed.
  const [needsToken, setNeedsToken] = useState(() => !hasToken());
  const root = useRef<HTMLDivElement>(null);

  const config = push.data;
  const actions = status?.actions;
  const blocked = unsupported();
  const askToken = Boolean(actions?.token) && needsToken;

  useEffect(() => {
    if (config) setEvents(savedEvents(config.defaults));
  }, [config]);

  // What this browser is already subscribed to, if the worker is there.
  useEffect(() => {
    if (blocked || !config?.enabled) return;
    let live = true;
    void navigator.serviceWorker
      .getRegistration('./')
      .then((found) => found?.pushManager.getSubscription())
      .then((existing) => {
        if (live) setSubscription(existing && config.publicKey && sameKey(existing, config.publicKey) ? existing : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [blocked, config]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'good', text: await work() });
      setNeedsToken(false);
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status === 401) {
        forgetToken();
        setNeedsToken(true);
      }
      setMessage({ tone: 'bad', text: failure.message });
    } finally {
      setBusy(false);
    }
  };

  const enable = (wanted: PushEvent[]) =>
    run(async () => {
      if (!config?.publicKey) throw new Error('The server has no key to subscribe with');
      if ((await Notification.requestPermission()) !== 'granted') {
        throw new Error('Notifications are blocked for this site: allow them in the browser’s site settings');
      }
      const worker = await registration();
      let current = await worker.pushManager.getSubscription();
      // Made with another key (the server's was replaced): it can no longer be sent to.
      if (current && !sameKey(current, config.publicKey)) {
        await current.unsubscribe();
        current = null;
      }
      current ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
      const result = await postJson<{ message: string }>('/api/actions/push/subscribe', { subscription: current.toJSON(), events: wanted });
      setSubscription(current);
      return result.message;
    });

  const disable = () =>
    run(async () => {
      if (!subscription) return 'Notifications are off for this browser.';
      const result = await postJson<{ message: string }>('/api/actions/push/unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
      setSubscription(null);
      return result.message;
    });

  const test = () =>
    run(async () => (await postJson<{ message: string }>('/api/actions/push/test', { endpoint: subscription!.endpoint })).message);

  const toggle = (event: PushEvent, on: boolean) => {
    const next = config!.events.filter((each) => (each === event ? on : events.includes(each)));
    setEvents(next);
    saveEvents(next);
    if (subscription) void enable(next);
  };

  if (!config?.enabled) return null;

  return (
    <div className="notify" ref={root}>
      <button
        type="button"
        className={`button small notify-toggle${subscription ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          const rect = root.current?.getBoundingClientRect();
          setOpenRight(rect !== undefined && rect.right < Math.min(PANEL_WIDTH, window.innerWidth - 32) + 16);
          setOpen(!open);
        }}
        title={subscription ? 'Notifications are on for this browser' : 'Get notified when Ralph needs you'}
      >
        <BellIcon />
        <span className="notify-label">{subscription ? 'Notifying' : 'Notify me'}</span>
      </button>
      {open ? (
        <div className={`notify-panel${openRight ? ' open-right' : ''}`} role="dialog" aria-label="Notifications">
          <div className="notify-title">Notifications on this device</div>
          {blocked ? (
            <p className="muted small">{blocked}</p>
          ) : !actions?.enabled ? (
            <p className="muted small">{actions?.reason ?? 'This web UI takes no actions, so it cannot take a subscription.'}</p>
          ) : (
            <>
              <fieldset className="notify-events">
                <legend className="muted small">Notify me when</legend>
                {config.events.map((event) => (
                  <label key={event}>
                    <input
                      type="checkbox"
                      checked={events.includes(event)}
                      disabled={busy}
                      onChange={(change) => toggle(event, change.target.checked)}
                    />
                    {EVENT_LABELS[event]}
                  </label>
                ))}
              </fieldset>
              {askToken ? (
                <label className="pending-field">
                  <span>Web UI token (ui.token)</span>
                  <input
                    type="password"
                    autoComplete="off"
                    onChange={(change) => rememberToken(change.target.value)}
                  />
                </label>
              ) : null}
              {message ? (
                <div className={`banner ${message.tone}`} role={message.tone === 'bad' ? 'alert' : 'status'}>
                  {message.text}
                </div>
              ) : null}
              <div className="notify-actions">
                {subscription ? (
                  <>
                    <button type="button" className="button small" disabled={busy} onClick={() => void test()}>
                      Send a test
                    </button>
                    <button type="button" className="button small danger" disabled={busy} onClick={() => void disable()}>
                      Turn off
                    </button>
                  </>
                ) : (
                  <button type="button" className="button small primary" disabled={busy || events.length === 0} onClick={() => void enable(events)}>
                    Turn on
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
