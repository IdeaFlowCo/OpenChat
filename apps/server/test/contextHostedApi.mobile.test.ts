import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn().mockResolvedValue('human-token'), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
import { api, onAuthExpired } from '../../mobile/src/api/client';
afterEach(() => { vi.unstubAllGlobals(); });
it('a stale hosted Context permission displays a typed error without signing out the human', async () => {
  const expired = vi.fn(); const off = onAuthExpired(expired);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Audience changed' }), { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(api.publishHostedContextRequest('request/a', { draftId: 'draft', approvalDigest: 'digest', text: 'Exact reply' })).rejects.toMatchObject({ status: 403 });
    expect(expired).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]; expect(url).toContain('request%2Fa/publish');
    expect(init.expireAuthOnForbidden).toBeUndefined(); expect(JSON.parse(init.body)).toEqual({ draftId: 'draft', approvalDigest: 'digest', text: 'Exact reply' });
  } finally { off(); }
});
it('expired authentication still signs out for hosted requests and existing calls preserve forbidden behavior', async () => {
  const expired = vi.fn(); const off = onAuthExpired(expired);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{}', { status: 403 })));
  try {
    await expect(api.getHostedContextPreferences()).rejects.toMatchObject({ status: 401 }); expect(expired).toHaveBeenCalledTimes(1);
    await expect(api.getConversations()).rejects.toMatchObject({ status: 403 }); expect(expired).toHaveBeenCalledTimes(2);
  } finally { off(); }
});
