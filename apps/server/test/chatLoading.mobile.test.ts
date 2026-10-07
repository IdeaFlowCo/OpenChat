import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../mobile/src/api/client.js';

const mocks = vi.hoisted(() => ({ getMessages: vi.fn(), getMessagesBefore: vi.fn(),
  wsSend: vi.fn(), send: vi.fn(), account: 'me', uuid: 0,
  markRead: vi.fn(), edit: vi.fn(), remove: vi.fn(), reaction: vi.fn(),
  handlers: new Map<string, (...args: any[]) => void>(),
}));
const socket = { connected: true, on: (event: string, handler: (...args: any[]) => void) => mocks.handlers.set(event, handler), off: (event: string) => mocks.handlers.delete(event) };
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => ++mocks.uuid === 1 ? 'client-message' : `client-message-${mocks.uuid}` }));
vi.mock('../../mobile/src/services/notifications', () => ({ setUnreadBadgeCount: vi.fn(), loadMutedConvs: async () => ({}) }));
vi.mock('../../mobile/src/api/client', () => ({
  api: { sendMessage: mocks.send, editMessage: mocks.edit, deleteMessage: mocks.remove, addReaction: mocks.reaction, markRead: mocks.markRead, getMessages: mocks.getMessages, getMessagesBefore: mocks.getMessagesBefore,
    getMe: async () => ({ id: mocks.account }), getConversations: async () => [{ id: 'sailing' }],
    listMatches: async () => [], getAiDisclosureStatus: async () => ({}), messagesSince: async () => ({ messages: [], truncated: true }),
  }, getToken: async () => 'test', getUser: async () => ({ userId: 'me' }), setSession: vi.fn(), clearSession: vi.fn(),
  onAuthExpired: () => vi.fn(),
  isDroppedMessageSend: (value: any) => value?.dropped === true,
}));
vi.mock('../../mobile/src/api/socket', () => ({ sendMessage: mocks.wsSend, joinConversation: vi.fn(), leaveConversation: vi.fn(), connect: async () => socket, disconnect: vi.fn(), emitPresenceUpdate: vi.fn() }));
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
  mocks.account = 'me';
  mocks.uuid = 0;
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


it('replaces disconnected cached history with a contiguous latest page', async () => {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  mocks.getMessages.mockResolvedValueOnce({ ...history, hasMore: true });
  await act(async () => chat.setActiveConversation('sailing'));
  const latest = { ...history.messages[0], id: 'latest', createdAt: '2026-10-01T00:00:00Z' };
  mocks.getMessages.mockResolvedValue({ messages: [latest], hasMore: true });
  await act(async () => { mocks.handlers.get('connect')!(); });
  expect(chat.messages).toEqual([latest]);
  mocks.getMessagesBefore.mockResolvedValue({ messages: history.messages, hasMore: false });
  await act(async () => chat.loadOlderMessages('sailing'));
  expect(mocks.getMessagesBefore).toHaveBeenCalledWith('sailing', latest.createdAt);
  expect(chat.messages).toEqual([...history.messages, latest]);
});

it.each(['edit', 'delete', 'reaction', 'transcript', 'preview'])('preserves an unloaded message %s while history is pending', async event => {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  const read = pendingPage(); mocks.getMessages.mockReturnValueOnce(read.promise);
  await act(async () => chat.setActiveConversation('sailing'));
  const m = history.messages[0];
  const reactions = [{ emoji: '👍', count: 1, byMe: false }];
  const preview = { url: 'https://example.test', title: 'Example' };
  await act(async () => {
    if (event === 'edit' || event === 'delete') mocks.handlers.get('message:updated')!({ ...m,
      content: event === 'edit' ? 'edited' : 'Message deleted',
      ...(event === 'delete' ? { deletedAt: '2026-10-01', attachments: null } : { editedAt: '2026-10-01' }),
    });
    if (event === 'reaction') mocks.handlers.get('message:reactions-updated')!({ messageId: m.id, conversationId: m.conversationId, reactions });
    if (event === 'transcript') mocks.handlers.get('message:transcript')!({ messageId: m.id, conversationId: m.conversationId, transcript: 'spoken words' });
    if (event === 'preview') mocks.handlers.get('message:preview-ready')!({ messageId: m.id, preview });
  });
  await act(async () => read.resolve(history));
  const loaded = chat.messages[0];
  if (event === 'edit') expect(loaded.content).toBe('edited');
  if (event === 'delete') expect(loaded.deletedAt).toBe('2026-10-01');
  if (event === 'reaction') expect(loaded.reactions).toEqual(reactions);
  if (event === 'transcript') expect(loaded.transcript).toBe('spoken words');
  if (event === 'preview') expect(loaded.linkPreviews).toEqual([preview]);
});

it('applies reaction fields without restoring content edited offline', async () => {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  mocks.getMessages.mockResolvedValueOnce(history);
  await act(async () => chat.setActiveConversation('sailing'));
  const read = pendingPage(); mocks.getMessages.mockReturnValueOnce(read.promise);
  await act(async () => chat.retryMessages());
  const reactions = [{ emoji: '👍', count: 1, byMe: false }];
  await act(async () => mocks.handlers.get('message:reactions-updated')!({ messageId: 'history', conversationId: 'sailing', reactions }));
  await act(async () => read.resolve({ messages: [{ ...history.messages[0], content: 'edited offline' }], hasMore: false }));
  expect(chat.messages[0]).toMatchObject({ content: 'edited offline', reactions });
});

it('only emits a read receipt while the selected Chat lane remains visible', async () => {
  vi.useFakeTimers();
  try {
    mocks.getMessages.mockResolvedValue(history);
    mocks.markRead.mockResolvedValue({ readMap: {}, onlineMap: {} });
    await act(async () => chat.setActiveConversation('sailing'));
    await act(async () => { chat.markConversationRead('sailing'); chat.setActiveConversationLane('context'); });
    await act(async () => vi.advanceTimersByTime(500));
    expect(mocks.markRead).not.toHaveBeenCalled();
    await act(async () => chat.markConversationRead('sailing'));
    await act(async () => vi.advanceTimersByTime(500));
    expect(mocks.markRead).not.toHaveBeenCalled();
    await act(async () => { chat.setActiveConversationLane('chat'); chat.markConversationRead('sailing'); });
    await act(async () => vi.advanceTimersByTime(500));
    expect(mocks.markRead).toHaveBeenCalledExactlyOnceWith('sailing');
    await act(async () => { chat.markConversationRead('sailing'); chat.setActiveConversation(null); });
    await act(async () => vi.advanceTimersByTime(500));
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});


it('retains a new live message when an empty history response arrives', async () => {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  const read = pendingPage(); mocks.getMessages.mockReturnValueOnce(read.promise);
  await act(async () => chat.setActiveConversation('sailing'));
  await act(async () => mocks.handlers.get('message:new')!(history.messages[0]));
  await act(async () => read.resolve({ messages: [], hasMore: false }));
  expect(chat.messages).toEqual(history.messages);
});

it('does not paginate cached history while a reload is in flight, even in the same tick', async () => {
  mocks.getMessages.mockResolvedValueOnce({ ...history, hasMore: true });
  await act(async () => chat.setActiveConversation('sailing'));
  const read = pendingPage(); mocks.getMessages.mockReturnValueOnce(read.promise);
  mocks.getMessagesBefore.mockResolvedValue({ messages: [], hasMore: false });
  await act(async () => { chat.retryMessages(); await chat.loadOlderMessages('sailing'); });
  expect(mocks.getMessagesBefore).not.toHaveBeenCalled();
  const latest = { ...history.messages[0], id: 'latest', createdAt: '2026-10-07T00:00:00Z' };
  await act(async () => read.resolve({ messages: [latest], hasMore: true }));
  await act(async () => chat.loadOlderMessages('sailing'));
  expect(mocks.getMessagesBefore).toHaveBeenCalledExactlyOnceWith('sailing', latest.createdAt);
});
it.each(['edit', 'delete', 'reaction'])('preserves a successful HTTP %s through a stale history response without a socket', async mutation => {
  mocks.getMessages.mockResolvedValueOnce(history);
  await act(async () => chat.setActiveConversation('sailing'));
  const read = pendingPage(); mocks.getMessages.mockReturnValueOnce(read.promise);
  await act(async () => chat.retryMessages());
  const reactions = [{ emoji: '👍', count: 1, byMe: true }];
  mocks.edit.mockResolvedValue({ ...history.messages[0], content: 'saved edit', editedAt: '2026-10-07' });
  mocks.remove.mockResolvedValue({ ...history.messages[0], content: 'Message deleted', deletedAt: '2026-10-07' });
  mocks.reaction.mockResolvedValue({ reactions });
  await act(async () => {
    if (mutation === 'edit') await chat.editMessage('history', 'saved edit');
    if (mutation === 'delete') await chat.deleteMessage('history');
    if (mutation === 'reaction') await chat.toggleReaction('history', '👍');
  });
  await act(async () => read.resolve(history));
  if (mutation === 'edit') expect(chat.messages[0].content).toBe('saved edit');
  if (mutation === 'delete') expect(chat.messages[0].deletedAt).toBe('2026-10-07');
  if (mutation === 'reaction') expect(chat.messages[0].reactions).toEqual(reactions);
});

const newestPage: Page = {
  messages: [{ ...history.messages[0], id: 'newest', createdAt: '2099-01-01T00:00:00Z' }],
  hasMore: true,
};
const emptyPage: Page = { messages: [], hasMore: false };
const image = { id: 'image', url: 'https://example.test/image.png', mimeType: 'image/png', size: 10 };

async function openSendingThread() {
  await act(async () => { await chat.bootstrapIfAuthed(); });
  mocks.getMessages.mockResolvedValue(emptyPage);
  await act(async () => chat.setActiveConversation('sailing'));
  await act(async () => mocks.handlers.get('connect')!());
}

async function reconnectWith(page: Page) {
  mocks.getMessages.mockResolvedValue(page);
  await act(async () => {
    mocks.handlers.get('disconnect')!();
    mocks.handlers.get('connect')!();
  });
}

it.each([
  { attachment: false, page: emptyPage }, { attachment: true, page: emptyPage },
  { attachment: false, page: newestPage }, { attachment: true, page: newestPage },
])('keeps failed send content after reconnect with attachment=$attachment and page=$page', async ({ attachment, page }) => {
  await openSendingThread();
  const offline = new Error('offline');
  mocks.wsSend.mockRejectedValue(offline);
  mocks.send.mockRejectedValue(offline);
  await act(async () => {
    await expect(chat.sendMessage('unsent text', undefined, attachment ? [image] : undefined)).rejects.toThrow('offline');
  });
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.wsSend).toHaveBeenCalledTimes(attachment ? 0 : 1);
  const local = chat.messages[0];
  expect(local).toMatchObject({ content: 'unsent text', _failed: true });
  await reconnectWith(page);
  expect(chat.messages).toEqual([local, ...page.messages]);
  if (page.hasMore) {
    mocks.getMessagesBefore.mockResolvedValue(history);
    await act(async () => chat.loadOlderMessages('sailing'));
    expect(mocks.getMessagesBefore).toHaveBeenCalledExactlyOnceWith('sailing', page.messages[0].createdAt);
    expect(chat.messages).toContainEqual(local);
    expect(chat.messages).toContainEqual(history.messages[0]);
  }
});

it.each([
  { transport: 'socket', page: emptyPage }, { transport: 'socket', page: newestPage },
  { transport: 'fallback', page: emptyPage }, { transport: 'attachment', page: newestPage },
])('keeps pending $transport sends through reconnect and deduplicates their acknowledgment', async ({ transport, page }) => {
  await openSendingThread();
  let acknowledge!: (message: Message) => void;
  const response = new Promise<Message>(resolve => { acknowledge = resolve; });
  if (transport === 'socket') mocks.wsSend.mockReturnValue(response);
  else {
    mocks.wsSend.mockRejectedValue(new Error('socket unavailable'));
    mocks.send.mockReturnValue(response);
  }
  let sending!: Promise<void>;
  await act(async () => { sending = chat.sendMessage('sending text', undefined, transport === 'attachment' ? [image] : undefined); });
  const local = chat.messages[0];
  expect(local).toMatchObject({ content: 'sending text' });
  await reconnectWith(page);
  expect(chat.messages).toEqual([local, ...page.messages]);
  const real: Message = { ...local, id: 'client-message' };
  await act(async () => mocks.handlers.get('message:new')!(real));
  await act(async () => { acknowledge(real); await sending; });
  expect(chat.messages.filter(message => message.id === real.id)).toEqual([real]);
  expect(chat.messages.some(message => message.id === local.id)).toBe(false);
  expect(chat.messages).toHaveLength(page.messages.length + 1);
});

function pendingSend() {
  let resolve!: (message: Message) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Message>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function failSend(content = 'retained text') {
  mocks.wsSend.mockRejectedValue(new Error('offline'));
  mocks.send.mockRejectedValue(new Error('offline'));
  await act(async () => { await expect(chat.sendMessage(content)).rejects.toThrow('offline'); });
  return chat.messages.find(message => message.content === content)!;
}

it('retains failed sends by conversation across blur, other threads and reopen', async () => {
  await openSendingThread();
  const sailing = await failSend('sailing text');
  await act(async () => chat.setActiveConversation(null));
  expect(chat.messages).toEqual([]);
  await act(async () => chat.setActiveConversation('other'));
  expect(chat.messages).toEqual([]);
  const other = await failSend('other text');
  await act(async () => chat.setActiveConversation('sailing', { lane: 'context' }));
  expect(chat.messages).toEqual([sailing]);
  expect(chat.activeConversationLane).toBe('context');
  await act(async () => chat.setActiveConversation('other'));
  expect(chat.messages).toEqual([other]);
});

it.each(['success', 'failure'] as const)('settles a late send %s in its retained conversation while another thread is selected', async outcome => {
  await openSendingThread();
  const response = pendingSend();
  mocks.wsSend.mockReturnValue(response.promise);
  mocks.send.mockRejectedValue(new Error('offline'));
  let sending!: Promise<void>;
  await act(async () => { sending = chat.sendMessage('late text'); });
  const local = chat.messages[0];
  await act(async () => chat.setActiveConversation(null));
  await act(async () => chat.setActiveConversation('other'));
  const real = { ...local, id: 'client-message' };
  await act(async () => {
    if (outcome === 'success') { response.resolve(real); await sending; }
    else { response.reject(new Error('offline')); await expect(sending).rejects.toThrow('offline'); }
  });
  expect(chat.messages).toEqual([]);
  await act(async () => chat.setActiveConversation('sailing'));
  expect(chat.messages).toEqual(outcome === 'success' ? [real] : [{ ...local, _failed: true }]);
});

it.each(['history', 'socket'] as const)('replaces a failed placeholder from %s when both acknowledgments were lost', async delivery => {
  await openSendingThread();
  const local = await failSend();
  expect(mocks.wsSend).toHaveBeenCalledWith('sailing', 'retained text', undefined, 'client-message');
  expect(mocks.send).toHaveBeenCalledWith('sailing', 'retained text', undefined, 'client-message', undefined);
  const real = { ...local, id: 'client-message' } as Message & { _failed?: boolean };
  delete real._failed;
  await act(async () => chat.setActiveConversation('other'));
  if (delivery === 'history') mocks.getMessages.mockImplementation(async id => id === 'sailing' ? { messages: [real], hasMore: false } : emptyPage);
  else await act(async () => mocks.handlers.get('message:new')!(real));
  expect(chat.messages).toEqual([]);
  await act(async () => chat.setActiveConversation('sailing'));
  expect(chat.messages).toEqual([real]);
  await act(async () => mocks.handlers.get('message:new')!(real));
  expect(chat.messages).toEqual([real]);
});

it.each([
  ['history', 'socket', 'ack'], ['history', 'ack', 'socket'],
  ['socket', 'history', 'ack'], ['socket', 'ack', 'history'],
  ['ack', 'history', 'socket'], ['ack', 'socket', 'history'],
])('deduplicates canonical delivery in %s → %s → %s order', async (...order) => {
  await openSendingThread();
  const response = pendingSend();
  mocks.wsSend.mockReturnValue(response.promise);
  let sending!: Promise<void>;
  await act(async () => { sending = chat.sendMessage('once'); });
  const real = { ...chat.messages[0], id: 'client-message' };
  for (const delivery of order) {
    await act(async () => {
      if (delivery === 'socket') mocks.handlers.get('message:new')!(real);
      if (delivery === 'history') {
        mocks.getMessages.mockResolvedValue({ messages: [real], hasMore: false });
        chat.retryMessages();
      }
      if (delivery === 'ack') { response.resolve(real); await sending; }
    });
    expect(chat.messages).toEqual([real]);
  }
  await act(async () => chat.setActiveConversation(null));
  await act(async () => chat.setActiveConversation('sailing'));
  expect(chat.messages).toEqual([real]);
});

it.each([
  { boundary: 'sign-out', outcome: 'success' }, { boundary: 'sign-out', outcome: 'failure' },
  { boundary: 'account-change', outcome: 'success' }, { boundary: 'account-change', outcome: 'failure' },
])('clears retained sends and ignores late $outcome across $boundary', async ({ boundary, outcome }) => {
  await openSendingThread();
  await failSend('old failed text');
  const response = pendingSend();
  mocks.wsSend.mockReturnValue(response.promise);
  let sending!: Promise<void>;
  await act(async () => { sending = chat.sendMessage('old pending text'); });
  const real = { ...chat.messages.find(message => message.content === 'old pending text')!, id: 'client-message-2' };
  if (boundary === 'sign-out') await act(async () => chat.signOut({ explicit: false }));
  mocks.account = 'new-account';
  await act(async () => { await chat.bootstrapIfAuthed(); });
  await act(async () => chat.setActiveConversation('sailing'));
  expect(chat.messages).toEqual([]);
  const fallbacks = mocks.send.mock.calls.length;
  await act(async () => {
    if (outcome === 'success') response.resolve(real);
    else response.reject(new Error('old socket failure'));
    await sending;
  });
  expect(mocks.send).toHaveBeenCalledTimes(fallbacks);
  expect(chat.messages).toEqual([]);
  await act(async () => chat.setActiveConversation(null));
  await act(async () => chat.setActiveConversation('sailing'));
  expect(chat.messages).toEqual([]);
});

it('sorts paginated messages around an older retained send using the persisted cursor', async () => {
  await openSendingThread();
  const local = await failSend();
  await reconnectWith(newestPage);
  const middle = { ...history.messages[0], id: 'middle', createdAt: '2098-01-01T00:00:00Z' };
  mocks.getMessagesBefore.mockResolvedValue({ messages: [middle, newestPage.messages[0]], hasMore: false });
  await act(async () => chat.loadOlderMessages('sailing'));
  expect(mocks.getMessagesBefore).toHaveBeenCalledExactlyOnceWith('sailing', newestPage.messages[0].createdAt);
  expect(chat.messages).toEqual([local, middle, newestPage.messages[0]]);
});

it('uses the loaded history anchor while an older acknowledged send awaits history confirmation', async () => {
  await openSendingThread();
  const response = pendingSend();
  mocks.wsSend.mockReturnValue(response.promise);
  let sending!: Promise<void>;
  await act(async () => { sending = chat.sendMessage('older acknowledged send'); });
  const real = { ...chat.messages[0], id: 'client-message' };
  await reconnectWith(newestPage);
  await act(async () => { response.resolve(real); await sending; });
  const middle = { ...history.messages[0], id: 'middle', createdAt: '2098-01-01T00:00:00Z' };
  mocks.getMessagesBefore.mockResolvedValue({ messages: [real, middle], hasMore: false });
  await act(async () => chat.loadOlderMessages('sailing'));
  expect(mocks.getMessagesBefore).toHaveBeenCalledExactlyOnceWith('sailing', newestPage.messages[0].createdAt);
  expect(chat.messages).toEqual([real, middle, newestPage.messages[0]]);
});
