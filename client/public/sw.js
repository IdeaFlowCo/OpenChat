/* OpenChat service worker.
 *
 * Strategy:
 *   - Pre-cache the app shell (HTML + manifest + icons) on install so the
 *     page boots offline / quickly on slow networks.
 *   - Runtime cache hashed JS/CSS assets (vite emits them under /assets/*).
 *   - NEVER cache /api/* or /socket.io/* — those must always hit the server.
 *
 * Bump CACHE_VERSION on every meaningful change to force clients to refresh.
 */
const CACHE_VERSION = 'openchat-v0.2.0-1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only.
  if (url.origin !== self.location.origin) return;

  // Never cache API / sockets / SSE / auth callbacks.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return; // Let the network handle it.
  }

  // Vite-hashed assets: cache-first (filename has hash → safe).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
      )
    );
    return;
  }

  // Navigations: network-first with shell fallback so offline still boots.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/index.html').then((m) => m || caches.match('/'))
      )
    );
    return;
  }

  // Default: try cache, fall back to network.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
