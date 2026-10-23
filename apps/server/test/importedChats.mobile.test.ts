import React from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigation: { navigate: vi.fn(), push: vi.fn(), setOptions: vi.fn(), addListener: vi.fn(() => () => {}) },
  focused: true,
  identityVerified: true,
  route: { params: {} as Record<string, unknown> },
  api: {
    listImportedChats: vi.fn(), getImportedChat: vi.fn(), listImportedMessages: vi.fn(), listImportedPeople: vi.fn(),
    listImportedAsks: vi.fn(), setImportedAskStatus: vi.fn(), getImportedPerson: vi.fn(),
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', ScrollView: 'ScrollView',
  FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent, ListFooterComponent }: any) => React.createElement('FlatList', null, ListHeaderComponent,
    data?.length ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent),
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => mocks.navigation, useRoute: () => mocks.route, useFocusEffect: (callback: () => void) => React.useEffect(() => mocks.focused ? callback() : undefined, [callback]) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ isIdentityVerified: mocks.identityVerified }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: mocks.api }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { ImportedChatsLink } from '../../mobile/src/components/ImportedChatsLink.js';
import { ImportedChatsScreen } from '../../mobile/src/screens/ImportedChatsScreen.js';
import { ImportedChatScreen } from '../../mobile/src/screens/ImportedChatScreen.js';
import { ImportedPersonScreen } from '../../mobile/src/screens/ImportedPersonScreen.js';

const coverage = { asOf: '2026-10-20T12:00:00.000Z', method: 'synthetic', earliestMessageAt: '2026-10-01T09:00:00.000Z', latestMessageAt: '2026-10-04T08:00:00.000Z', complete: false, note: 'Media not imported.', sourceRowCounts: { total: 18, text: 5, nonText: 13 }, lastImportAt: null, importCount: 1 };
const chat = { id: 'chat-1', network: 'whatsapp', chatType: 'group', title: 'Synthetic Garden Club', coverage, counts: { messages: 3, participants: 2, openAsks: 1 } };
const ada = { participantId: 'pa-ada1', label: 'Ada Example', displayName: 'Ada Example', isOwner: false };
const unknown = { participantId: 'pa-ab12', label: 'Unknown participant 3', displayName: null, isOwner: false };
const message = (id: string, extra: Record<string, unknown>) => ({ id, sourceMessageId: id, sentAt: '2026-10-01T09:05:00.000Z', kind: 'text', text: null, mediaType: null, edited: false, editedAt: null, originalText: null, deletedAtSource: null, replyToSourceMessageId: null, sender: ada, ...extra });
const ask = { id: 'ask-1', text: 'Looking for compost suppliers', subject: null, subjectLabel: 'Cy', reporter: ada, sourceStatus: 'open', ownerStatus: null, status: 'open', stale: false, updatedAt: '', statusSources: [],
  sources: [{ sourceMessageId: 'm-2', sentAt: '2026-10-01T09:05:00.000Z', sender: ada, text: 'My friend Cy is hunting for compost suppliers', available: true }] };

let root: ReturnType<typeof create> | undefined;
const texts = () => root!.root.findAllByType('Text' as any).map(node => node.children.flat().map(child => typeof child === 'string' ? child : '').join('')).join('\n');
const button = (label: string): ReactTestInstance => root!.root.findAll(node => node.type === ('TouchableOpacity' as any) && node.props.accessibilityLabel === label)[0]!;
async function render(element: React.ReactElement) { await act(async () => { root = create(element); }); }

beforeEach(() => {
  vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.identityVerified = true;
  mocks.api.listImportedChats.mockResolvedValue({ chats: [chat] });
  mocks.api.getImportedChat.mockResolvedValue(chat);
  mocks.api.listImportedMessages.mockResolvedValue({ nextCursor: null, messages: [
    message('m-3', { kind: 'deleted', sender: unknown }),
    message('m-2', { text: 'Hi all, I run a soil-health lab.', edited: true, editedAt: '2026-10-01T10:00:00.000Z', originalText: 'Hi all.' }),
    message('m-1', { kind: 'system', text: 'Group created', sender: null }),
  ] });
  mocks.api.listImportedPeople.mockResolvedValue({ people: [
    { ...ada, nameSource: 'push_name', membership: 'current', account: null, messageCount: 2, firstMessageAt: null, lastMessageAt: null, factCount: 1, askCount: 0 },
    { ...unknown, nameSource: 'unknown', account: null, messageCount: 1, firstMessageAt: null, lastMessageAt: null, factCount: 0, askCount: 0 },
  ] });
  mocks.api.listImportedAsks.mockResolvedValue({ asks: [ask] });
  mocks.api.setImportedAskStatus.mockImplementation(async (_chat: string, _ask: string, ownerStatus: string | null) => ({ ask: { ...ask, ownerStatus, status: ownerStatus ?? 'open' } }));
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

describe('imported chats front door', () => {
  it('waits for online identity verification after cached chats render, then loads without another focus event', async () => {
    mocks.focused = false;
    mocks.identityVerified = false;
    await render(React.createElement(ImportedChatsLink));
    expect(root!.toJSON()).toBeNull();
    expect(mocks.api.listImportedChats).not.toHaveBeenCalled();
    mocks.identityVerified = true;
    await act(async () => root!.update(React.createElement(ImportedChatsLink)));
    expect(texts()).toContain('Imported chats');
    expect(mocks.api.listImportedChats).toHaveBeenCalledTimes(1);
    mocks.identityVerified = false;
    await act(async () => root!.update(React.createElement(ImportedChatsLink)));
    expect(root!.toJSON()).toBeNull();
  });

  it('loads when the phone header mounts without a focus event, and refreshes on later focus', async () => {
    mocks.focused = false;
    await render(React.createElement(ImportedChatsLink));
    expect(texts()).toContain('Imported chats');
    expect(mocks.api.listImportedChats).toHaveBeenCalledTimes(1);
    const focus = (mocks.navigation.addListener.mock.calls as unknown[][]).find(call => call[0] === 'focus')![1] as () => void;
    mocks.api.listImportedChats.mockResolvedValueOnce({ chats: [] });
    await act(async () => focus());
    expect(root!.toJSON()).toBeNull();
  });

  it('stays hidden until the owner has an imported chat, then opens the list in one tap', async () => {
    mocks.api.listImportedChats.mockResolvedValueOnce({ chats: [] });
    await render(React.createElement(ImportedChatsLink));
    expect(root!.toJSON()).toBeNull();
    await act(async () => root!.unmount());
    await render(React.createElement(ImportedChatsLink));
    expect(texts()).toContain('Imported chats');
    await act(async () => button('Imported chats, 1').props.onPress());
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ImportedChats');
  });

  it('is registered in the Chats stack and placed on the phone and desktop Chats lists', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const app = read('../../mobile/App.tsx');
    for (const name of ['ImportedChats', 'ImportedChat', 'ImportedPerson']) expect(app).toContain(`name="${name}"`);
    expect(read('../../mobile/src/screens/ConversationsScreen.tsx')).toContain('<ImportedChatsLink />');
    expect(read('../../mobile/src/components/ConversationList.tsx')).toContain('<ImportedChatsLink variant=');
    expect(read('../../../docs/surface-map.md')).toMatch(/\| `ImportedChats` .*\*\*Imported chats\*\*/);
  });

  it('lists mirrors with their source and coverage, and opens one', async () => {
    await render(React.createElement(ImportedChatsScreen));
    expect(texts()).toContain('Only you see them');
    const row = button('Synthetic Garden Club, WhatsApp mirror · read-only');
    expect(row.findAllByType('Text' as any).map(n => n.props.children).join(' ')).toContain('Partial history');
    await act(async () => row.props.onPress());
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ImportedChat', { chatId: 'chat-1', title: 'Synthetic Garden Club' });
  });
});

describe('imported chat screen', () => {
  beforeEach(() => { mocks.route.params = { chatId: 'chat-1', title: 'Synthetic Garden Club' }; });

  it('reads as a private, read-only mirror with no way to send', async () => {
    await render(React.createElement(ImportedChatScreen));
    const shown = texts();
    expect(shown).toContain('Private to you · WhatsApp mirror · read-only');
    expect(shown).toContain('As of');
    expect(shown).toContain('Hi all, I run a soil-health lab.');
    expect(shown).toContain('Deleted by the sender on WhatsApp');
    expect(shown).toContain('Group created');
    expect(shown).toContain('Read-only copy. Nothing here is sent to anyone.');
    expect(shown).toContain('18 source rows · 5 text, 13 other');
    expect(root!.root.findAllByType('TextInput' as any)).toHaveLength(0);
    await act(async () => button('Open Ada Example').props.onPress());
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ImportedPerson', { chatId: 'chat-1', participantId: 'pa-ada1' });
  });

  it('shows everyone in People, unnamed and unlinked people honestly', async () => {
    await render(React.createElement(ImportedChatScreen));
    await act(async () => button('People').props.onPress());
    const shown = texts();
    expect(shown).toContain('Unknown participant 3');
    expect(shown).toContain('Current member · 2 messages');
    expect(shown).toContain('Not linked to an OpenChat account');
    expect(shown).not.toMatch(/@lid|@s\.whatsapp/);
    expect(shown).not.toMatch(/not on OpenChat|not a user/i);
  });

  it('attributes asks to subject and reporter and saves the owner’s status', async () => {
    await render(React.createElement(ImportedChatScreen));
    expect(texts()).toContain('Asks · 1 open');
    expect(texts()).toContain('People 2');
    await act(async () => button('Asks').props.onPress());
    const shown = texts();
    expect(shown).toContain('Cy · not in this chat');
    expect(shown).toContain('My friend Cy is hunting for compost suppliers');
    await act(async () => button('Resolved').props.onPress());
    expect(mocks.api.setImportedAskStatus).toHaveBeenCalledWith('chat-1', 'ask-1', 'resolved');
    expect(texts()).toContain('You set this. The source shows open.');
    await act(async () => button('Use source status').props.onPress());
    expect(mocks.api.setImportedAskStatus).toHaveBeenLastCalledWith('chat-1', 'ask-1', null);
  });
});

describe('imported person mini-profile', () => {
  it('shows only evidenced facts and an honest empty state for someone unknown', async () => {
    mocks.route.params = { chatId: 'chat-1', participantId: 'pa-ab12' };
    mocks.api.getImportedPerson.mockResolvedValue({
      chat: { id: 'chat-1', title: 'Synthetic Garden Club', network: 'whatsapp', coverage },
      person: { ...unknown, nameSource: 'unknown', account: null, messageCount: 1, firstMessageAt: null, lastMessageAt: null, factCount: 0, askCount: 0 },
      facts: [], asksAbout: [], asksReported: [], recentMessages: [message('m-4', { kind: 'media', mediaType: 'image', sender: unknown })],
    });
    await render(React.createElement(ImportedPersonScreen));
    const shown = texts();
    expect(shown).toContain('Unknown participant 3');
    expect(shown).toContain('Name not known · Membership not known');
    expect(shown).toContain('Not linked to an OpenChat account');
    expect(shown).toContain('Nothing in this chat describes them yet.');
    expect(shown).toContain('image · not imported');
    expect(shown).toContain('Private to you; they are not told.');
  });

  it('cites the source message for every fact', async () => {
    mocks.route.params = { chatId: 'chat-1', participantId: 'pa-ada1' };
    mocks.api.getImportedPerson.mockResolvedValue({
      chat: { id: 'chat-1', title: 'Synthetic Garden Club', network: 'whatsapp', coverage },
      person: { ...ada, nameSource: 'self_stated', membership: 'current', account: null, messageCount: 2, firstMessageAt: null, lastMessageAt: null, factCount: 1, askCount: 0 },
      nameSources: [{ sourceMessageId: 'm-2', sentAt: '2026-10-01T09:05:00.000Z', sender: ada, text: 'Hi all, Ada here.', available: true }],
      facts: [{ id: 'f1', text: 'Runs a soil-health lab', stale: false, sources: [{ sourceMessageId: 'm-2', sentAt: '2026-10-01T09:05:00.000Z', sender: ada, text: 'I run a soil-health lab.', available: true }] }],
      asksAbout: [], asksReported: [], recentMessages: [],
    });
    await render(React.createElement(ImportedPersonScreen));
    const shown = texts();
    expect(shown).toContain('Runs a soil-health lab');
    expect(shown).toContain('I run a soil-health lab.');
    expect(shown).toContain('Name from their own message · Current member');
    expect(shown).toContain('Hi all, Ada here.');
  });
});
