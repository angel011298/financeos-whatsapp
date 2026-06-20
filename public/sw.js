// OnlyUs — Service Worker
// DEPLOY_TS is injected by the server on every Railway deploy
// so the browser always detects a changed SW and installs the new version.
const V = 'DEPLOY_TS';
const CACHE = 'onlyus-' + V;

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  // Pre-cache only the manifest; index.html is always fetched fresh from network.
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['/manifest.json'])).catch(() => {})
  );
  // Activate immediately — do NOT wait for old tabs to close.
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // Delete every cache that isn't the current version.
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      // Take control of all open tabs immediately.
      .then(() => self.clients.claim())
      // Signal open tabs to reload so they get the latest index.html.
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', v: V })))
  );
});

// ── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // API calls: always live, never intercept.
  if (url.pathname.startsWith('/api/')) return;

  // sw.js itself: never cache (let server always serve fresh).
  if (url.pathname === '/sw.js') return;

  // manifest + icons: cache-first with background revalidation (rarely changes).
  if (url.pathname === '/manifest.json' || url.pathname.startsWith('/icon')) {
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(e.request).then(cached => {
          const fresh = fetch(e.request, { cache: 'no-store' })
            .then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })
            .catch(() => cached);
          return cached || fresh;
        })
      )
    );
    return;
  }

  // HTML: siempre desde la red, NUNCA almacenar en caché SW.
  // El servidor inyecta _BUILD_TS y headers Surrogate-Control: no-store.
  e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match('/')));
});
