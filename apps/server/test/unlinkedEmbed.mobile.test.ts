import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
import { isEmbedSessionMessage } from '../../mobile/src/services/unlinkedEmbed';
import { getToken, getUser, setSession, clearSession } from '../../mobile/src/api/client';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('ignores standalone credentials and keeps embedded sessions in memory', async () => {
  vi.stubGlobal('window', { location: { search: '?embed=unlinked' } });
  storage.getItem.mockResolvedValue('standalone-secret');
  expect(await getToken()).toBeNull(); expect(await getUser()).toBeNull();
  await setSession('embedded-secret', { userId: 'unlinked-owner', email: 'fixture@example.invalid' });
  expect(await getToken()).toBe('embedded-secret'); expect((await getUser())?.userId).toBe('unlinked-owner');
  await clearSession(); expect(await getToken()).toBeNull();
  expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled();
});
it('accepts sessions only from the intended parent, origin, and handshake', () => {
  const parent = {}; vi.stubGlobal('window', { parent });
  const event = { origin: 'https://www.unlinked.ai', source: parent, data: { type: 'unlinked:session', nonce: 'nonce', token: 'token', user: { userId: 'owner' } } };
  expect(isEmbedSessionMessage(event as MessageEvent, 'nonce')).toBe(true);
  expect(isEmbedSessionMessage({ ...event, origin: 'https://evil.invalid' } as MessageEvent, 'nonce')).toBe(false);
  expect(isEmbedSessionMessage({ ...event, source: {} } as MessageEvent, 'nonce')).toBe(false);
  expect(isEmbedSessionMessage(event as MessageEvent, 'other')).toBe(false);
});
