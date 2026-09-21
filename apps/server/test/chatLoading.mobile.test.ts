import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../mobile/src/api/client.js';

const mocks = vi.hoisted(() => ({ getMessages: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('../../mobile/src/services/notifications', () => ({ setUnreadBadgeCount: vi.fn() }));
vi.mock('../../mobile/src/api/client', () => ({
  api: { getMessages: mocks.getMessages }, onAuthExpired: () => vi.fn(),
}));
vi.mock('../../mobile/src/api/socket', () => ({ joinConversation: vi.fn(), leaveConversation: vi.fn() }));
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
  vi.clearAllMocks();
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
