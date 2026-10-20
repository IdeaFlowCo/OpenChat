import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
import { OfflineChat, retryableSendError, type PendingMessage } from '../../mobile/src/services/offlineChat';

const disk = new Map<string, string>();
const storage = {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: vi.fn(async (key: string, value: string) => { disk.set(key, value); }),
  removeItem: async (key: string) => { disk.delete(key); },
  getAllKeys: async () => [...disk.keys()],
};
const entry = (clientId = 'one', account = 'alice'): PendingMessage => ({ clientId, state: 'queued', message: {
  id: `local-${clientId}`, conversationId: 'chat', senderId: account, content: 'Saved on the train', createdAt: '2026-10-19T01:00:00Z',
} });
beforeEach(() => { disk.clear(); storage.setItem.mockClear(); });
it('loads only the signed-in account and preserves independent sends from two tabs', async () => {
  const a = new OfflineChat('alice', storage), b = new OfflineChat('alice', storage);
  await Promise.all([a.put(entry()), b.put(entry('two'))]);
  const other = new OfflineChat('bob', storage); await other.load();
  expect(other.pending.size).toBe(0);
  const restored = new OfflineChat('alice', storage); await restored.load();
  expect([...restored.pending.keys()].sort()).toEqual(['one', 'two']);
});
it('does not accept a message when storage fails', async () => {
  storage.setItem.mockRejectedValueOnce(new Error('disk full'));
  const store = new OfflineChat('alice', storage);
  await expect(store.put(entry())).rejects.toThrow('disk full');
  expect(store.pending.size).toBe(0);
  await store.put(entry());
  expect(store.pending.size).toBe(1);
});
it('keeps outbox data through history eviction and session expiry, but clears it on sign-out', async () => {
  const store = new OfflineChat('alice', storage);
  await store.put(entry());
  for (let index = 0; index < 35; index++) {
    await store.saveMessages(`chat-${index}`, Array.from({ length: 120 }, (_, n) => ({
      ...entry().message, id: `real-${n}`, conversationId: `chat-${index}`,
    })));
  }
  expect(Object.keys(store.cache.threads)).toHaveLength(30);
  expect(store.cache.threads['chat-34']).toHaveLength(100);
  await store.close();
  const restored = new OfflineChat('alice', storage); await restored.load();
  expect(restored.pending.get('one')).toEqual(entry());
  await restored.close(true);
  expect(disk.size).toBe(0);
});
it('removes revoked conversations from cached history', async () => {
  const store = new OfflineChat('alice', storage);
  await store.saveMessages('chat', [{ ...entry().message, id: 'real' }]);
  await store.saveConversations([]);
  expect(store.cache.threads).toEqual({});
});
it.each([undefined, 408, 429, 500, 503])('retries transport or temporary failure %s', status => {
  expect(retryableSendError({ status })).toBe(true);
});
it.each([400, 401, 403, 404, 413, 422])('does not automatically retry rejection %s', status => {
  expect(retryableSendError({ status })).toBe(false);
});
