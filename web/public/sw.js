// Ralph's service worker: shows the push notifications the web UI's server
// sends, and opens the UI on the view a notification is about. Plain script,
// copied as is into the build, so it is served beside index.html and its
// scope is wherever the browser reached the UI (any proxy prefix included).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ralph', {
      body: data.body || '',
      tag: data.tag || 'ralph',
      icon: 'favicon.svg',
      data: { path: data.path || '#/overview', base: data.base || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { path, base } = event.notification.data || {};
  const target = new URL(path || '#/overview', base || self.registration.scope);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => {
        const url = new URL(client.url);
        return url.origin === target.origin && url.pathname === target.pathname;
      });
      if (!open) return self.clients.openWindow(target.href);
      // Focus while the click still counts as the person's; then show the view.
      const focused = await open.focus();
      try {
        await focused.navigate(target.href);
      } catch {
        // Not ours to navigate (opened before this worker): it is in front, at least.
      }
    })(),
  );
});
