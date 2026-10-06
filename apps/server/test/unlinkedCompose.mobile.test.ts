import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ blur: undefined as (() => void) | undefined, create: vi.fn(), send: vi.fn(), replace: vi.fn(), navigate: vi.fn(), contacts: vi.fn(), status: vi.fn(), resolve: vi.fn(), goBack: vi.fn(), params: { source: 'unlinked', profile: 'https://www.unlinked.ai/people/public-id' as string | undefined, card: undefined as string | undefined } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => navigation, useRoute: () => ({ params: mocks.params }), useFocusEffect: (effect: () => () => void) => React.useEffect(() => { const cleanup = effect(); mocks.blur = cleanup; return cleanup; }, [effect]) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ createConversation: mocks.create, sendMessageToConversation: mocks.send }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContacts: mocks.contacts, getCardFriendStatus: mocks.status, resolveUnlinkedRecipient: mocks.resolve } }));
import { ComposeScreen } from '../../mobile/src/screens/ComposeScreen';
const navigation = { replace: mocks.replace, navigate: mocks.navigate, goBack: mocks.goBack };
let root: ReturnType<typeof create>;
const button = (label: string) => root.root.findAllByType('TouchableOpacity').find(n => n.findAllByType('Text').some(t => t.props.children === label))!;
const mount = async () => act(async () => { root = create(React.createElement(ComposeScreen)); });
beforeEach(() => {
  vi.resetAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.params = { source: 'unlinked', profile: 'https://www.unlinked.ai/people/public-id', card: undefined };
  mocks.resolve.mockResolvedValue({ status: 'ready', recipient: { id: 'bob', name: 'Bob' } });
  mocks.create.mockResolvedValue({ id: 'existing-dm' });
});
afterEach(async () => { await act(async () => root?.unmount()); expect(mocks.send).not.toHaveBeenCalled(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('opens the verified owner’s normal conversation without a separate draft or Send step', async () => {
  await mount();
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(mocks.params.profile);
  expect(mocks.contacts).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(['bob'], { type: 'direct' });
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('Chat', { conversationId: 'existing-dm' });
  expect(root.root.findAllByType('TextInput')).toHaveLength(0);
  expect(button('Send message')).toBeUndefined();
  await act(async () => root.update(React.createElement(ComposeScreen)));
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('offers an invite for an unclaimed contact without opening an unrelated conversation', async () => {
  mocks.resolve.mockResolvedValue({ status: 'unclaimed', name: 'Alice' }); await mount();
  await act(async () => button('Get an invite link').props.onPress());
  expect(mocks.navigate).toHaveBeenCalledWith('MyCard');
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
});
it('does not open an unavailable profile', async () => {
  mocks.resolve.mockResolvedValue({ status: 'unavailable' }); await mount();
  expect(button('Get an invite link')).toBeUndefined();
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
});
it('keeps resolution failures distinct from unclaimed profiles and retries', async () => {
  mocks.resolve.mockRejectedValueOnce(new Error('offline')); await mount();
  expect(button('Get an invite link')).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled();
  await act(async () => button('Try again').props.onPress());
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('Chat', { conversationId: 'existing-dm' });
});
it('retries the same canonical direct-conversation service if opening fails', async () => {
  mocks.create.mockRejectedValueOnce(new Error('offline')); await mount();
  expect(mocks.replace).not.toHaveBeenCalled();
  await act(async () => button('Try again').props.onPress());
  expect(mocks.create.mock.calls).toEqual([[['bob'], { type: 'direct' }], [['bob'], { type: 'direct' }]]);
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('Chat', { conversationId: 'existing-dm' });
});
it('does not let a slow previous profile select the new recipient', async () => {
  let resolve!: (value: unknown) => void;
  mocks.resolve.mockReturnValueOnce(new Promise(r => { resolve = r; })); await mount();
  mocks.params = { ...mocks.params, profile: 'https://www.unlinked.ai/people/b' };
  await act(async () => root.update(React.createElement(ComposeScreen)));
  await act(async () => resolve({ status: 'ready', recipient: { id: 'wrong', name: 'Wrong' } }));
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(['bob'], { type: 'direct' });
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('Chat', { conversationId: 'existing-dm' });
});
it('ignores a previous conversation finishing after switching profiles', async () => {
  let resolve!: (value: { id: string }) => void;
  mocks.create.mockReturnValueOnce(new Promise(r => { resolve = r; })); await mount();
  mocks.params = { ...mocks.params, profile: 'https://www.unlinked.ai/people/b' };
  await act(async () => root.update(React.createElement(ComposeScreen)));
  await act(async () => resolve({ id: 'old-dm' }));
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('Chat', { conversationId: 'existing-dm' });
});
it('does not navigate after Back dismisses a pending entry', async () => {
  let resolve!: (value: { id: string }) => void;
  mocks.create.mockReturnValueOnce(new Promise(r => { resolve = r; })); await mount();
  await act(async () => { button('Cancel').props.onPress(); root.unmount(); });
  await act(async () => resolve({ id: 'old-dm' }));
  expect(mocks.goBack).toHaveBeenCalledOnce(); expect(mocks.replace).not.toHaveBeenCalled();
});
it('uses an explicit card recipient instead of profile context', async () => {
  mocks.params.card = 'a'.repeat(24);
  mocks.status.mockResolvedValue({ userId: 'owner' });
  await mount(); expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(['owner'], { type: 'direct' });
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('Chat', { conversationId: 'existing-dm' });
});
it('opens the standard recipient picker for a generic compose link', async () => {
  mocks.params.profile = undefined; await mount();
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('NewConversation');
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});

it('does not route an older entry that remains mounted behind a newer screen', async () => {
  let resolve!: (value: { id: string }) => void;
  mocks.create.mockReturnValueOnce(new Promise(r => { resolve = r; })); await mount();
  await act(async () => mocks.blur?.());
  await act(async () => resolve({ id: 'old-dm' }));
  expect(mocks.replace).not.toHaveBeenCalled();
});
