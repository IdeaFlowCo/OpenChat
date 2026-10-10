import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  navigation: { navigate: vi.fn(), replace: vi.fn() }, createConversation: vi.fn(), getContacts: vi.fn(), listFriends: vi.fn(),
  conversations: [] as any[], listBlocked: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: vi.fn() }, Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', KeyboardAvoidingView: 'KeyboardAvoidingView',
  FlatList: ({ data, renderItem, ListEmptyComponent }: any) => React.createElement('FlatList', {}, data?.length ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))) : ListEmptyComponent),
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => mocks.navigation }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'me', openUserDirectoryEnabled: true }, conversations: mocks.conversations, presence: new Map(), createConversation: mocks.createConversation }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContacts: mocks.getContacts, listFriends: mocks.listFriends, listBlocked: mocks.listBlocked } }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/BotBadge', () => ({ BotBadge: () => null }));
vi.mock('../../mobile/src/components/YouBadge', () => ({ YouBadge: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { NewConversationScreen } from '../../mobile/src/screens/NewConversationScreen.js';

let root: ReturnType<typeof create> | undefined;
const texts = () => root!.root.findAllByType('Text').map(n => [n.props.children].flat(Infinity).filter(c => typeof c === 'string').join(''));
const button = (label: string) => root!.root.findAllByType('TouchableOpacity').find(n => n.findAllByType('Text').some(t => t.props.children === label));
const dm = (id: string, name: string, at: string) => ({ id: `c-${id}`, type: 'direct', lastMessageAt: at, participants: [{ user: { id: 'me', name: 'Me' } }, { user: { id, name } }] });

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.conversations = [dm('hq', 'Harrison Qian', '2026-10-08T00:00:00Z'), dm('cl', 'Claire', '2026-10-09T00:00:00Z')];
  mocks.listFriends.mockResolvedValue({ friends: [{ userId: 'mg', user: { id: 'mg', name: 'Michael G' }, state: 'friends' }], incoming: [], outgoing: [] });
  mocks.getContacts.mockReturnValue(new Promise(() => {})); // the directory never answers
  mocks.createConversation.mockResolvedValue({ id: 'new' });
  mocks.listBlocked.mockResolvedValue([]);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.useRealTimers(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

describe('New message (OpenChat-eo3n.2)', () => {
  it('shows Recent then Friends instantly, without the directory, and no invite/scan rows or id fragments', async () => {
    await act(async () => { root = create(React.createElement(NewConversationScreen)); });
    const t = texts();
    expect(t.indexOf('Recent')).toBeLessThan(t.indexOf('Claire'));
    expect(t.indexOf('Claire')).toBeLessThan(t.indexOf('Harrison Qian'));
    expect(t.indexOf('Friends')).toBeLessThan(t.indexOf('Michael G'));
    expect(t.indexOf('Harrison Qian')).toBeLessThan(t.indexOf('Friends'));
    expect(t).toContain('New group');
    expect(t).not.toContain('Invite a person');
    expect(t).not.toContain('Direct Message');
    expect(t.some(line => line.startsWith('OpenChat · '))).toBe(false);
  });

  it('filters people you talk to as you type, before any debounce', async () => {
    await act(async () => { root = create(React.createElement(NewConversationScreen)); });
    await act(async () => root!.root.findAllByType('TextInput')[0]!.props.onChangeText('qian'));
    expect(texts()).toContain('Harrison Qian');
    expect(texts()).not.toContain('Claire');
    await act(async () => button('Harrison Qian')!.props.onPress());
    expect(mocks.createConversation).toHaveBeenCalledWith(['hq'], { type: 'direct' });
  });

  it('offers Invite a person and Scan a code when nobody matches', async () => {
    mocks.getContacts.mockResolvedValue([]);
    await act(async () => { root = create(React.createElement(NewConversationScreen)); });
    await act(async () => root!.root.findAllByType('TextInput')[0]!.props.onChangeText('zzz'));
    await act(async () => vi.advanceTimersByTime(350));
    expect(texts()).toContain('No one named “zzz” yet.');
    await act(async () => button('Invite a person')!.props.onPress());
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('InvitePerson');
    await act(async () => button('Scan a code')!.props.onPress());
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ScanQr');
  });

  it('New group selects people and creates the group; Cancel returns to a direct message', async () => {
    await act(async () => { root = create(React.createElement(NewConversationScreen)); });
    await act(async () => button('New group')!.props.onPress());
    await act(async () => button('Claire')!.props.onPress());
    expect(mocks.createConversation).not.toHaveBeenCalled();
    await act(async () => button('Create group (1)')!.props.onPress());
    expect(mocks.createConversation).toHaveBeenCalledWith(['cl'], { type: 'group', title: undefined });
  });

  it('leaves people you blocked out of Recent', async () => {
    mocks.listBlocked.mockResolvedValue([{ id: 'cl', name: 'Claire' }]);
    await act(async () => { root = create(React.createElement(NewConversationScreen)); });
    expect(texts()).not.toContain('Claire');
    expect(texts()).toContain('Harrison Qian');
  });
});
