import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../mobile/src/api/client.js';

const mocks = vi.hoisted(() => ({ getMessages: vi.fn(), getMessagesBefore: vi.fn(),
  handlers: new Map<string, (...args: any[]) => void>(),
}));
const socket = { connected: true, on: (event: string, handler: (...args: any[]) => void) => mocks.handlers.set(event, handler), off: (event: string) => mocks.handlers.delete(event) };
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('../../mobile/src/services/notifications', () => ({ setUnreadBadgeCount: vi.fn(), loadMutedConvs: async () => ({}) }));
vi.mock('../../mobile/src/api/client', () => ({
  api: { getMessages: mocks.getMessages, getMessagesBefore: mocks.getMessagesBefore,
    getMe: async () => ({ id: 'me' }), getConversations: async () => [{ id: 'sailing' }],
    listMatches: async () => [], getAiDisclosureStatus: async () => ({}), messagesSince: async () => ({ messages: [], truncated: true }),
  }, getToken: async () => 'test', getUser: async () => ({ userId: 'me' }), setSession: vi.fn(), clearSession: vi.fn(),
  onAuthExpired: () => vi.fn(),
}));
vi.mock('../../mobile/src/api/socket', () => ({ joinConversation: vi.fn(), leaveConversation: vi.fn(), connect: async () => socket, disconnect: vi.fn(), emitPresenceUpdate: vi.fn() }));
vi.mock('../../mobile/src/components/InAppMessageBanner', () => ({ showInAppBanner: vi.fn() }));

import { ChatProvider, useChat } from '../../mobile/src/contexts/ChatContext.js';

type Page = { messages: Message[]; hasMore: boolean };
function pendingPage() {
  let resolve!: (page: Page) => void;
  const promise = new Promise<Page>(done => { resolve = done; });
  return { promise, resolve };
}
const history: Page = {
  messages: [{ id: 'history', conversationId: 'sailing', content: 'hello', senderId: 'alice', createdAt: '2026-09-21T00:00:00Z' }],
  hasMore: false,
};
let chat: ReturnType<typeof useChat>;
let root: ReturnType<typeof create>;
function Probe() { chat = useChat(); return null; }

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => { root = create(React.createElement(ChatProvider, null, React.createElement(Probe))); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

it('keeps the selected group loading when an older thread request completes', async () => {
  const previous = pendingPage();
  const selected = pendingPage();
  mocks.getMessages.mockReturnValueOnce(previous.promise).mockReturnValueOnce(selected.promise);
  await act(async () => { chat.setActiveConversation('previous'); });
  await act(async () => { chat.setActiveConversation('sailing'); });
  await act(async () => { previous.resolve({ messages: [], hasMore: false }); });
  expect(chat.loadingMessages).toBe(true);
  await act(async () => { selected.resolve(history); });
  expect(chat.loadingMessages).toBe(false);
  expect(chat.messages).toEqual(history.messages);
});

it('ignores an earlier load when the same group is closed and reopened', async () => {
  const previous = pendingPage();
  const reopened = pendingPage();
  mocks.getMessages.mockReturnValueOnce(previous.promise).mockReturnValueOnce(reopened.promise);
  await act(async () => { chat.setActiveConversation('sailing'); });
  await act(async () => { chat.setActiveConversation(null); });
  expect(chat.loadingMessages).toBe(false);
  await act(async () => { chat.setActiveConversation('sailing'); });
  await act(async () => { previous.resolve(history); });
  expect(chat.loadingMessages).toBe(true);
  expect(chat.messages).toEqual([]);
  await act(async () => { reopened.resolve({ messages: [], hasMore: false }); });
  expect(chat.loadingMessages).toBe(false);
  expect(chat.messages).toEqual([]);
});

it('exposes a failed initial load and retries without changing the selected lane', async () => {
  mocks.getMessages.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(history);
  await act(async () => chat.setActiveConversation('sailing', { lane: 'context' }));
  expect(chat.loadingMessages).toBe(false);
  expect(chat.messageLoadError).toContain('Could not load');
  await act(async () => chat.retryMessages());
  expect(chat.messageLoadError).toBeNull();
  expect(chat.messages).toEqual(history.messages);
  expect(chat.activeConversationLane).toBe('context');
});

it('does not overwrite a live message or edit with a slower history response', async () => {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  const read = pendingPage(); mocks.getMessages.mockReturnValueOnce(read.promise);
  await act(async () => chat.setActiveConversation('sailing'));
  const live = { ...history.messages[0], id: 'live', createdAt: '2026-09-22T00:00:00Z' };
  await act(async () => { mocks.handlers.get('message:new')!(live); });
  await act(async () => { mocks.handlers.get('message:updated')!({ ...live, content: 'edited live' }); });
  await act(async () => read.resolve({ messages: [...history.messages, live], hasMore: false }));
  expect(chat.messages.map(m => m.id)).toEqual(['history', 'live']);
  expect(chat.messages[1].content).toBe('edited live');
});

it('repairs the visible thread after reconnect even when catch-up is truncated', async () => {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  mocks.getMessages.mockRejectedValueOnce(new Error('deploying')).mockResolvedValue(history);
  await act(async () => chat.setActiveConversation('sailing'));
  await act(async () => { mocks.handlers.get('connect')!(); });
  await act(async () => { mocks.handlers.get('disconnect')!(); mocks.handlers.get('connect')!(); });
  expect(chat.messages).toEqual(history.messages);
  expect(chat.messageLoadError).toBeNull();
});

it('discards an older page after closing and reopening the same thread', async () => {
  mocks.getMessages.mockResolvedValue({ ...history, hasMore: true });
  await act(async () => chat.setActiveConversation('sailing'));
  const older = pendingPage(); mocks.getMessagesBefore.mockReturnValueOnce(older.promise);
  let loading!: Promise<void>;
  await act(async () => { loading = chat.loadOlderMessages('sailing'); });
  await act(async () => chat.setActiveConversation(null));
  mocks.getMessages.mockResolvedValue({ messages: [], hasMore: false });
  await act(async () => chat.setActiveConversation('sailing'));
  await act(async () => { older.resolve(history); await loading; });
  expect(chat.messages).toEqual([]);
  expect(chat.hasMoreMessages).toBe(false);
});
