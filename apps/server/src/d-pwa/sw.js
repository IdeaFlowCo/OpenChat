/**
 * OpenChat /app/ service worker (OpenChat-3rw).
 *
 * Minimal PWA-qualifying service worker. Network-first; caches only the
 * app shell so we never stale-serve chat messages. The fetch handler is
 * deliberately defensive — if the network fails we fall through to the
 * cached shell so the UI can boot offline and surface a "you're offline"
 * banner from inside the app.
 *
 * Auto-update: on every page load the browser checks for a new sw.js. If
 * the bytes change, the new SW activates immediately (clients.claim()) so
 * users get fresh code without manual cache-clearing. Server deploys are
 * therefore the canonical "update" path.
 */

// Bump this when the app shell changes meaningfully — forces re-cache.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `openchat-app-shell-${CACHE_VERSION}`;
const APP_SHELL = ['/app/', '/app/index.html', '/app/favicon.ico'];

self.addEventListener('install', (event) => {
  // Activate the new SW the moment it finishes installing — don't wait
  // for the user to close every tab.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => null))
  );
});

self.addEventListener('activate', (event) => {
  // Take over all open clients + clear stale shell caches from older
  // CACHE_VERSIONs so users boot off the new shell on next navigation.
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => (
          (k.startsWith('openchat-app-shell-') || k.startsWith('openchat-d-shell-'))
          && k !== CACHE_NAME
        )).map((k) => caches.delete(k)))
      ),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only intercept GETs — POST/PUT/DELETE etc. always go to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // NEVER cache API / socket / auth routes — those need fresh data.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/legal/') ||
    url.pathname.startsWith('/about/')
  ) {
    return;
  }

  // App shell: network-first, fall back to cache on failure (offline).
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.pathname.startsWith('/app/')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) =>
          cached || caches.match('/app/index.html').then((fallback) =>
            fallback || new Response('Offline', { status: 503, statusText: 'Offline' })
          )
        )
      )
  );
});
