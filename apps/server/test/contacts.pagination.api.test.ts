import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => null, setItem: async () => {}, removeItem: async () => {},
} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
import { api, clearSession, setSession } from '../../mobile/src/api/client';
import { setAuthenticatedRequestGuard } from '../../mobile/src/api/authenticatedRequest';

afterEach(async () => { await clearSession(); vi.unstubAllGlobals(); });

it('passes opaque page cursors and returns pagination metadata from the authenticated native API', async () => {
  await setSession('synthetic-token', { userId: 'synthetic-owner', email: 'owner@example.invalid' });
  const release = setAuthenticatedRequestGuard(async token => token === 'synthetic-token');
  const page = { things: [{ id: 'synthetic-person', name: 'Synthetic', kind: 'person' }], nextCursor: 'next-scoped-cursor', total: 5007 };
  const fetch = vi.fn(async (url, init) => {
    const request = new URL(url);
    expect(Object.fromEntries(request.searchParams)).toEqual({ q: 'A & B', kind: 'person', after: 'owner+/=?&cursor', limit: '100' });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token');
    return new Response(JSON.stringify(page));
  });
  vi.stubGlobal('fetch', fetch);
  try { expect(await api.listPrivateThings('A & B', 'person', { after: 'owner+/=?&cursor', limit: 100 })).toEqual(page); }
  finally { release(); }
  expect(fetch).toHaveBeenCalledOnce();
});
