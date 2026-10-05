import { beforeEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { setItem: async (key: string, value: string) => { storage.set(key, value); }, getItem: async (key: string) => storage.get(key) || null, removeItem: async (key: string) => { storage.delete(key); } } }));
import { captureComposeIntent, clearComposeIntent, loadComposeIntent } from '../../mobile/src/services/composeIntents';
beforeEach(() => { storage.clear(); });
it('retains safe incoming context across sign-in reload until routed', async () => {
  const intent = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/public-id' };
  await captureComposeIntent(intent); expect(await loadComposeIntent()).toEqual(intent);
  await clearComposeIntent(); expect(await loadComposeIntent()).toBeNull();
});
it('expires abandoned context and rejects tampered private payload', async () => {
  storage.set('openchat:compose_intent', JSON.stringify({ capturedAt: Date.now() - 3600001, intent: { source: 'unlinked' } }));
  expect(await loadComposeIntent()).toBeNull();
  storage.set('openchat:compose_intent', JSON.stringify({ capturedAt: Date.now(), intent: { source: 'unlinked', profile: 'https://private.unlinked.ai/people/secret' } }));
  expect(await loadComposeIntent()).toBeNull();
});
