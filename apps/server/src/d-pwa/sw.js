/** Account data lives in the app's account-scoped store. This worker caches
 * only the public /app shell and its build assets, never API/auth/media data. */
const CACHE_NAME = 'openchat-app-shell-__BUILD_VERSION__';
// Replaced by infra/prepare-offline-shell.mjs with the exact exported assets.
const APP_SHELL = /* OFFLINE_ASSETS */ ['/app/', '/app/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(async cache => {
    // A partial bundle must not replace the previous working offline version.
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(key =>
      (key.startsWith('openchat-app-shell-') || key.startsWith('openchat-d-shell-'))
      && key !== CACHE_NAME).map(key => caches.delete(key)))),
  ]));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () =>
      (await caches.open(CACHE_NAME)).match('/app/index.html')
        .then(cached => cached || new Response('Connect once to save OpenChat for offline use.', { status: 503 }))));
    return;
  }
  // Only the build manifest's public static files are cacheable. Never serve
  // HTML in place of a missing script, image, or cross-origin request.
  if (url.search || !APP_SHELL.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache =>
    (await cache.match(req)) || fetch(req)));
});
