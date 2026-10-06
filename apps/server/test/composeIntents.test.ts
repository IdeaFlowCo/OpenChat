import { beforeEach, expect, it, vi } from 'vitest';
const embed = vi.hoisted(() => ({ active: false }));
vi.mock('../../mobile/src/services/unlinkedEmbed', () => ({ isUnlinkedEmbed: () => embed.active }));
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { setItem: async (key: string, value: string) => { storage.set(key, value); }, getItem: async (key: string) => storage.get(key) || null, removeItem: async (key: string) => { storage.delete(key); } } }));
import { captureComposeIntent, consumeComposeIntent, loadComposeIntent, loadPendingComposeIntent } from '../../mobile/src/services/composeIntents';
beforeEach(() => { storage.clear(); embed.active = false; });
it('retains safe incoming context across sign-in reload until routed', async () => {
  const intent = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/public-id' };
  await captureComposeIntent(intent); expect(await loadComposeIntent()).toEqual(intent);
  await consumeComposeIntent((await loadPendingComposeIntent())!.revision); expect(await loadComposeIntent()).toBeNull();
});
it('expires abandoned context and rejects tampered private payload', async () => {
  storage.set('openchat:compose_intent', JSON.stringify({ capturedAt: Date.now() - 3600001, intent: { source: 'unlinked' } }));
  expect(await loadComposeIntent()).toBeNull();
  storage.set('openchat:compose_intent', JSON.stringify({ capturedAt: Date.now(), intent: { source: 'unlinked', profile: 'https://private.unlinked.ai/people/secret' } }));
  expect(await loadComposeIntent()).toBeNull();
});

it('consumes A without deleting a newer capture B', async () => {
  await captureComposeIntent({ source: 'unlinked', profile: 'https://www.unlinked.ai/people/a' });
  const a = (await loadPendingComposeIntent())!;
  await captureComposeIntent({ source: 'unlinked', profile: 'https://www.unlinked.ai/people/b' });
  expect(await consumeComposeIntent(a.revision)).toBe(false);
  expect((await loadComposeIntent())?.profile).toBe('https://www.unlinked.ai/people/b');
});

it('isolates embedded recipients from standalone storage, without reading or changing standalone storage', async () => {
  const standalone = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/standalone' };
  const embedded = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/embedded' };
  await captureComposeIntent(standalone);
  const saved = storage.get('openchat:compose_intent');
  embed.active = true;
  expect(await loadComposeIntent()).toBeNull();
  await captureComposeIntent(embedded);
  expect(await loadComposeIntent()).toEqual(embedded);
  await consumeComposeIntent((await loadPendingComposeIntent())!.revision);
  expect(await loadComposeIntent()).toBeNull();
  expect(storage.get('openchat:compose_intent')).toBe(saved);
  embed.active = false;
  expect(await loadComposeIntent()).toEqual(standalone);
});
