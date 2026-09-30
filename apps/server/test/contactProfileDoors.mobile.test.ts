import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigation: { navigate: vi.fn(), replace: vi.fn(), setOptions: vi.fn() }, createConversation: vi.fn(), getContacts: vi.fn(), listFriends: vi.fn(), search: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: vi.fn() }, Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
  FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent }: any) => React.createElement('FlatList', null, ListHeaderComponent, data?.length ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))) : ListEmptyComponent),
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => mocks.navigation, useRoute: () => ({ params: {} }), useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'alice', openUserDirectoryEnabled: true }, conversations: [], presence: new Map(), createConversation: mocks.createConversation }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContacts: mocks.getContacts, listFriends: mocks.listFriends, search: mocks.search } }));
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
  vi.clearAllMocks(); vi.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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
