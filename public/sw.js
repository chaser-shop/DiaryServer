/* Service worker: офлайн-оболонка + Web Push сповіщення. */
const CACHE = 'diary-shell-v10';
const SHELL = ['/', '/style.css', '/app.js', '/schedule.js', '/device.js', '/theme.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Мережа в пріоритеті, кеш — запасний варіант (щоб застосунок відкривався без інтернету).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Щоденник', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Щоденник', {
      body: d.body || '',
      tag: d.tag,
      data: d.data || {},
      actions: d.actions || [],
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      renotify: !!d.tag,
    }),
    // Якщо щоденник відкритий — просимо його одразу оновити дані (наприклад, після зміни ролі).
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => list.forEach((c) => c.postMessage({ type: 'sync' }))),
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = e.action === 'none' && data.noneUrl ? data.noneUrl : data.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'route', url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});