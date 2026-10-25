import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: async (key: string, value: string) => { disk.set(key, value); },
  removeItem: async (key: string) => { disk.delete(key); },
  getAllKeys: async () => [...disk.keys()],
} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'offline-id' }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default } }));
vi.mock('expo-image-picker', () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' } }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/', cacheDirectory: 'file:///cache/', FileSystemUploadType: { BINARY_CONTENT: 0 },
  copyAsync: vi.fn(), deleteAsync: vi.fn(), makeDirectoryAsync: vi.fn(), getInfoAsync: vi.fn(), uploadAsync: vi.fn(), downloadAsync: vi.fn() }));
vi.mock('../../mobile/src/services/notifications', () => ({ setUnreadBadgeCount: vi.fn(), setActiveConversationForNotifications: vi.fn(), loadMutedConvs: async () => ({}) }));
vi.mock('../../mobile/src/services/haptics', () => ({ hapticTickle: vi.fn() }));
vi.mock('../../mobile/src/components/InAppMessageBanner', () => ({ showInAppBanner: vi.fn() }));
vi.mock('../../mobile/src/api/socket', () => ({ connect: async () => ({ connected: true, on() {}, off() {} }), disconnect: vi.fn(), joinConversation: vi.fn(), leaveConversation: vi.fn(), emitPresenceUpdate: vi.fn(), sendMessage: vi.fn() }));

import { api, clearSession, setSession } from '../../mobile/src/api/client';
import { ChatProvider, useChat } from '../../mobile/src/contexts/ChatContext';
import { transformMessage } from '../../mobile/src/services/messageTransform';

let chat: ReturnType<typeof useChat>;
let root: ReturnType<typeof create>;
let identity: (value: Response) => void;
const fetchMock = vi.fn();
const conversation = { id: 'shared', type: 'group', title: 'Saved conversation', participants: [] };
const json = (value: unknown) => new Response(JSON.stringify(value));
function Probe() { chat = useChat(); return null; }

beforeEach(async () => {
  vi.useFakeTimers();
  disk.clear();
  await clearSession();
  await setSession('token-B', { userId: 'alice', email: 'alice@example.invalid' });
  disk.set('openchat:offline:v1:alice:cache', JSON.stringify({ conversations: [conversation], threads: { shared: [] } }));
  const pending = new Promise<Response>(resolve => { identity = resolve; });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/me' && !init?.method) return pending;
    if (path === '/api/chat/conversations') return json([conversation]);
    if (path.endsWith('/messages')) return json({ messages: [], hasMore: false });
    if (path.endsWith('/read')) return json({ readMap: { peer: '2026-10-19T01:00:00Z' }, onlineMap: { peer: true } });
    if (path.includes('matches')) return json({ matches: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => { root = create(React.createElement(ChatProvider, null, React.createElement(Probe))); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  await clearSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

it('keeps cached chats and composition available without sending wrong-account reads or actions', async () => {
  let boot!: Promise<boolean>;
  await act(async () => { boot = chat.bootstrapIfAuthed(); });
  expect(chat.conversations).toEqual([conversation]);
  await act(async () => {
    chat.setActiveConversation('shared');
    chat.registerConversationVisibility('shared');
  });
  await act(async () => { chat.markConversationRead('shared'); await vi.advanceTimersByTimeAsync(500); });
  await expect(api.markRead('shared')).rejects.toThrow('identity is not verified');
  await expect(api.getMe()).rejects.toThrow('identity is not verified');
  await expect(api.updateProfile({ name: 'Changed' })).rejects.toThrow('identity is not verified');
  await expect(api.registerNativePushToken('synthetic-push', 'ios')).rejects.toThrow('identity is not verified');
  await expect(api.deleteThought('synthetic-thought')).rejects.toThrow('identity is not verified');
  await expect(transformMessage('private text', 'concise')).rejects.toThrow('identity is not verified');
  await act(async () => chat.sendMessage('offline text'));
  expect(chat.messages.at(-1)).toMatchObject({ id: 'local-offline-id', content: 'offline text', _delivery: 'queued' });
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/auth/me']);
  expect(chat.readByOthers.size).toBe(0);
  expect(chat.onlineUsers.size).toBe(0);
  await act(async () => { identity(json({ id: 'bob' })); await boot; });
  expect(chat.isAuthed).toBe(false);
  expect([...disk.values()].join()).toContain('offline text');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('allows ordinary authenticated APIs and read receipt ingestion after identity verification', async () => {
  let boot!: Promise<boolean>;
  await act(async () => { boot = chat.bootstrapIfAuthed(); });
  await act(async () => { identity(json({ id: 'alice' })); await boot; });
  await act(async () => {
    chat.setActiveConversation('shared');
    chat.registerConversationVisibility('shared');
  });
  await act(async () => { chat.markConversationRead('shared'); await vi.advanceTimersByTimeAsync(500); });
  expect(chat.readByOthers.get('shared')?.get('peer')).toBe('2026-10-19T01:00:00Z');
  expect(chat.onlineUsers.get('peer')).toBe(true);
  await expect(api.updateProfile({ name: 'Alice' })).resolves.toEqual({});
  const requests = fetchMock.mock.calls.filter(([url]) => !url.endsWith('/api/auth/me'));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(([, init]) => init.headers.authorization === 'Bearer token-B')).toBe(true);
});

it('rejects an in-flight response when the authenticated account changes', async () => {
  let boot!: Promise<boolean>;
  await act(async () => { boot = chat.bootstrapIfAuthed(); });
  await act(async () => { identity(json({ id: 'alice' })); await boot; });
  let complete!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  fetchMock.mockImplementationOnce(() => pending);
  const reading = api.markRead('shared');
  const rejected = expect(reading).rejects.toThrow('Chat session ended');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await setSession('token-C', { userId: 'carol', email: '' });
  complete(json({ readMap: { wrong: 'now' }, onlineMap: { wrong: true } }));
  await rejected;
});

it('rejects response bodies decoded after the verified session is invalidated', async () => {
  let boot!: Promise<boolean>;
  await act(async () => { boot = chat.bootstrapIfAuthed(); });
  await act(async () => { identity(json({ id: 'alice' })); await boot; });
  let decode!: (value: unknown) => void;
  let decoding!: () => void;
  const entered = new Promise<void>(resolve => { decoding = resolve; });
  const response = json({});
  response.json = () => { decoding(); return new Promise(resolve => { decode = resolve; }); };
  fetchMock.mockResolvedValueOnce(response);
  const reading = api.markRead('shared');
  const rejected = expect(reading).rejects.toThrow('Chat session ended');
  await entered;
  await act(async () => chat.signOut({ explicit: false }));
  decode({ readMap: { wrong: 'now' }, onlineMap: { wrong: true } });
  await rejected;
});

it('keeps public invite previews usable before identity verification without sending a token', async () => {
  await expect(api.getInvitePreview('public-invite')).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
});
