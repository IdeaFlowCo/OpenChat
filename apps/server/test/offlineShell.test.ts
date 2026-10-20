import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, expect, it, vi } from 'vitest';

let handlers: Record<string, (event: any) => void>;
const cached = new Response('saved shell');
const cache = { addAll: vi.fn(async () => {}), match: vi.fn(async () => cached) };
const fetcher = vi.fn();
beforeEach(() => {
  handlers = {}; vi.clearAllMocks();
  runInNewContext(readFileSync('src/d-pwa/sw.js', 'utf8'), {
    URL, Response, fetch: fetcher,
    caches: { open: async () => cache, keys: async () => [], delete: vi.fn() },
    self: { location: { origin: 'https://chat.example' }, clients: { claim: vi.fn() }, skipWaiting: vi.fn(),
      addEventListener: (name: string, handler: any) => { handlers[name] = handler; } },
  });
});
it('preloads the shell as one complete install', async () => {
  let work!: Promise<void>;
  handlers.install({ waitUntil: (promise: Promise<void>) => { work = promise; } });
  await work;
  expect(cache.addAll).toHaveBeenCalledWith(['/app/', '/app/index.html']);
});
it.each(['/api/chat/messages', '/socket.io/', '/auth/callback', '/uploads/photo.jpg', 'https://other.example/app/index.html'])('never intercepts private or cross-origin request %s', path => {
  const respondWith = vi.fn();
  handlers.fetch({ request: { method: 'GET', url: new URL(path, 'https://chat.example').href }, respondWith });
  expect(respondWith).not.toHaveBeenCalled();
});
it('opens saved app HTML offline for deep links without caching the URL or its auth query', async () => {
  fetcher.mockRejectedValue(new Error('offline'));
  let result!: Promise<Response>;
  handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://chat.example/app/chat/room?token=private' },
    respondWith: (promise: Promise<Response>) => { result = promise; } });
  expect(await result).toBe(cached);
  expect(cache.match).toHaveBeenCalledWith('/app/index.html');
});
it('does not substitute HTML for a missing script', () => {
  const respondWith = vi.fn();
  handlers.fetch({ request: { method: 'GET', mode: 'cors', url: 'https://chat.example/app/missing.js' }, respondWith });
  expect(respondWith).not.toHaveBeenCalled();
});
