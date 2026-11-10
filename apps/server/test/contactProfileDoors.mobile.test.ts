import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default }, navigation: { navigate: vi.fn(), replace: vi.fn(), setOptions: vi.fn() }, createPrivateThing: vi.fn(), listPrivateThings: vi.fn(), createConversation: vi.fn(), getContacts: vi.fn(), listFriends: vi.fn(), search: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: mocks.platform, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: vi.fn() }, Modal: ({ visible, children }: any) => (visible ? children : null), Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
  FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent, ListFooterComponent, onEndReached }: any) => React.createElement('FlatList', { onEndReached }, ListHeaderComponent, data?.length ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => mocks.navigation, useRoute: () => ({ params: {} }), useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'alice', openUserDirectoryEnabled: true }, conversations: [], presence: new Map(), createConversation: mocks.createConversation }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { listPrivateThings: mocks.listPrivateThings, createPrivateThing: mocks.createPrivateThing, getContacts: mocks.getContacts, listFriends: mocks.listFriends, listBlocked: async () => [], search: mocks.search } }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/BotBadge', () => ({ BotBadge: () => null }));
vi.mock('../../mobile/src/components/YouBadge', () => ({ YouBadge: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { FriendsScreen } from '../../mobile/src/screens/FriendsScreen.js';
import { NewConversationScreen } from '../../mobile/src/screens/NewConversationScreen.js';
import { SearchScreen } from '../../mobile/src/screens/SearchScreen.js';
let root: ReturnType<typeof create> | undefined;
const person = { id: 'bob', name: 'Official Bob' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.platform.OS = 'ios'; vi.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.listPrivateThings.mockResolvedValue({ things: [], nextCursor: null, total: 0 });
  mocks.getContacts.mockResolvedValue([person]);
  mocks.listFriends.mockResolvedValue({ friends: [{ userId: 'bob', user: person, state: 'friends' }], incoming: [], outgoing: [] });
  mocks.search.mockResolvedValue({ contacts: [person], conversations: [], messages: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.useRealTimers(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
describe('canonical-person profile doors without a DM', () => {
  it.each([FriendsScreen, NewConversationScreen, SearchScreen])('opens Profile from %s without creating or sending a chat', async Screen => {
    await act(async () => { root = create(React.createElement(Screen)); });
    if (Screen === SearchScreen) {
      await act(async () => root!.root.findByType('TextInput').props.onChangeText('Bob'));
      await act(async () => vi.advanceTimersByTime(350));
    }
    const door = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Profile for Official Bob')!;
    expect(door).toBeDefined(); expect(door.findAllByType('Text').some(n => n.props.children === 'Profile')).toBe(true);
    const stopPropagation = vi.fn();
    await act(async () => door.props.onPress({ stopPropagation }));
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ContactProfile', { userId: 'bob' });
    expect(mocks.createConversation).not.toHaveBeenCalled();
    if (Screen !== FriendsScreen) expect(stopPropagation).toHaveBeenCalled();
  });
});

it('keeps exact-email proof tied to the completed contact result while query changes', async () => {
  await act(async () => { root = create(React.createElement(SearchScreen)); });
  await act(async () => root!.root.findByType('TextInput').props.onChangeText('bob@example.test'));
  await act(async () => vi.advanceTimersByTime(350));
  await act(async () => root!.root.findByType('TextInput').props.onChangeText('someone@example.test'));
  const door = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Profile for Official Bob')!;
  await act(async () => door.props.onPress({ stopPropagation: vi.fn() }));
  expect(mocks.navigation.navigate).toHaveBeenCalledWith('ContactProfile', { userId: 'bob', exactEmail: 'bob@example.test' });
  expect(mocks.createConversation).not.toHaveBeenCalled();
});

it.each(['ios', 'web'])('carries completed People email proof in Direct and Group modes on %s', async platform => {
  mocks.platform.OS = platform;
  await act(async () => { root = create(React.createElement(NewConversationScreen)); });
  const searchInput = () => root!.root.findAllByType('TextInput').find(n => n.props.placeholder?.includes('exact email'))!;
  const profileDoor = () => root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Profile for Official Bob')!;
  const groupButton = root!.root.findAllByType('TouchableOpacity').find(n => n.findAllByType('Text').some(child => child.props.children === 'New group'))!;
  await act(async () => searchInput().props.onChangeText(' BOB@example.test '));
  await act(async () => vi.advanceTimersByTime(350));
  const stopPropagation = vi.fn();
  await act(async () => profileDoor().props.onPress({ stopPropagation }));
  expect(mocks.navigation.navigate).toHaveBeenLastCalledWith('ContactProfile', { userId: 'bob', exactEmail: 'BOB@example.test' });
  await act(async () => groupButton.props.onPress());
  const pills = () => root!.root.findAllByType('TouchableOpacity').filter(n => n.props.accessibilityLabel === 'Remove Official Bob');
  expect(pills()).toHaveLength(0);
  await act(async () => profileDoor().props.onPress({ stopPropagation }));
  expect(pills()).toHaveLength(0);
  expect(mocks.createConversation).not.toHaveBeenCalled();
  const row = profileDoor().parent!;
  await act(async () => row.props.onPress());
  expect(pills()).toHaveLength(1);
  let resolve: (rows: typeof person[]) => void = () => {};
  mocks.getContacts.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => searchInput().props.onChangeText('someone@example.test'));
  await act(async () => vi.advanceTimersByTime(350));
  await act(async () => profileDoor().props.onPress({ stopPropagation }));
  expect(mocks.navigation.navigate).toHaveBeenLastCalledWith('ContactProfile', { userId: 'bob', exactEmail: 'BOB@example.test' });
  await act(async () => resolve([{ id: 'carol', name: 'Official Carol' }]));
  const carol = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Profile for Official Carol')!;
  await act(async () => carol.props.onPress({ stopPropagation }));
  expect(mocks.navigation.navigate).toHaveBeenLastCalledWith('ContactProfile', { userId: 'carol', exactEmail: 'someone@example.test' });
  expect(mocks.createConversation).not.toHaveBeenCalled();
});

it.each(['Bob', 'bob@', '@example.test', 'bob@example', 'a b@example.test', `${'a'.repeat(255)}@example.test`])('does not carry People proof for non-complete email %s', async query => {
  await act(async () => { root = create(React.createElement(NewConversationScreen)); });
  await act(async () => root!.root.findByType('TextInput').props.onChangeText(query));
  await act(async () => vi.advanceTimersByTime(350));
  const door = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Profile for Official Bob')!;
  await act(async () => door.props.onPress({ stopPropagation: vi.fn() }));
  expect(mocks.navigation.navigate).toHaveBeenCalledWith('ContactProfile', { userId: 'bob' });
  expect(mocks.createConversation).not.toHaveBeenCalled();
});

it('discards a late directory page after People email results complete', async () => {
  const directory = Array.from({ length: 50 }, (_, i) => ({ id: `directory-${i}`, name: `Directory ${i}` }));
  mocks.getContacts.mockResolvedValueOnce(directory);
  await act(async () => { root = create(React.createElement(NewConversationScreen)); });
  let resolve: (rows: typeof person[]) => void = () => {};
  mocks.getContacts.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => root!.root.findByType('FlatList').props.onEndReached());
  await act(async () => root!.root.findByType('TextInput').props.onChangeText('bob@example.test'));
  await act(async () => vi.advanceTimersByTime(350));
  await act(async () => resolve([{ id: 'late', name: 'Late Directory' }]));
  expect(root!.root.findAllByType('TouchableOpacity').some(n => n.props.accessibilityLabel === 'Profile for Late Directory')).toBe(false);
  const door = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Profile for Official Bob')!;
  await act(async () => door.props.onPress({ stopPropagation: vi.fn() }));
  expect(mocks.navigation.navigate).toHaveBeenCalledWith('ContactProfile', { userId: 'bob', exactEmail: 'bob@example.test' });
});

it('creates a private saved person from People and opens their profile without messaging', async () => {
  mocks.createPrivateThing.mockResolvedValue({ id: 'saved-chet', kind: 'person', name: 'Chet' });
  await act(async () => { root = create(React.createElement(FriendsScreen)); });
  const byText = (label: string) => root!.root.findAllByType('TouchableOpacity').find(n => n.findAllByType('Text').some(t => t.props.children === label))!;
  await act(async () => byText('+ Add person').props.onPress());
  await act(async () => root!.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'Saved person name')!.props.onChangeText('Chet'));
  await act(async () => byText('Save privately').props.onPress());
  expect(mocks.createPrivateThing).toHaveBeenCalledWith('person', 'Chet');
  expect(mocks.navigation.navigate).toHaveBeenCalledWith('PrivateThing', { thingId: 'saved-chet' });
  expect(mocks.createConversation).not.toHaveBeenCalled();
});
it('opens an existing saved person profile from People', async () => {
  mocks.listPrivateThings.mockResolvedValue({ things: [{ id: 'saved', kind: 'person', name: 'Chet' }], nextCursor: null, total: 1 });
  await act(async () => { root = create(React.createElement(FriendsScreen)); });
  const door = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel === 'Saved profile for Chet')!;
  expect(door).toBeDefined();
  expect(door.findAllByType('Text').some(n => n.props.children === 'Private profile')).toBe(true);
  await act(async () => door.props.onPress());
  expect(mocks.navigation.navigate).toHaveBeenCalledWith('PrivateThing', { thingId: 'saved' });
  expect(mocks.createConversation).not.toHaveBeenCalled();
});

// Copy/select audit 2026-11: a message hit's row opens the chat on tap, so
// press-and-hold shows the whole message selectable with Copy all.
it('long-press on a message search hit shows the full message selectable', async () => {
  const content = 'Tea at four? Bring the oolong. '.repeat(6).trim();
  mocks.search.mockResolvedValue({ contacts: [], conversations: [], messages: [{ id: 'm1', content, conversationId: 'c1', senderId: 'ana', createdAt: '2026-11-01T00:00:00Z', sender: { id: 'ana', name: 'Ana' }, conversationTitle: 'Tea club', conversationType: 'group' }] });
  await act(async () => { root = create(React.createElement(SearchScreen)); });
  await act(async () => root!.root.findByType('TextInput').props.onChangeText('tea'));
  await act(async () => vi.advanceTimersByTime(350));
  const row = root!.root.findAllByType('TouchableOpacity').find(n => String(n.props.accessibilityHint ?? '').includes('Press and hold'))!;
  expect(root!.root.findAll(n => n.props.testID === 'selectable-text-sheet-body')).toHaveLength(0);
  await act(async () => row.props.onLongPress());
  const body = root!.root.findAll(n => n.props.testID === 'selectable-text-sheet-body' && typeof n.type === 'string')[0];
  expect(body.props.selectable).toBe(true);
  expect(body.props.children).toBe(content);
});
