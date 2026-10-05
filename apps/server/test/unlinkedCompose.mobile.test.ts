import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), replace: vi.fn(), navigate: vi.fn(), contacts: vi.fn(), card: vi.fn(), status: vi.fn(), resolve: vi.fn(), goBack: vi.fn(), params: { source: 'unlinked', profile: 'https://www.unlinked.ai/people/public-id', card: undefined as string | undefined } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ replace: mocks.replace, navigate: mocks.navigate, goBack: mocks.goBack }), useRoute: () => ({ params: mocks.params }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ createConversation: mocks.create, sendMessageToConversation: mocks.send }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContacts: mocks.contacts, getPublicCard: mocks.card, getCardFriendStatus: mocks.status, resolveUnlinkedRecipient: mocks.resolve } }));
import { ComposeScreen } from '../../mobile/src/screens/ComposeScreen';
let root: ReturnType<typeof create>;
const button = (label: string) => root.root.findAllByType('TouchableOpacity').find(n => n.findAllByType('Text').some(t => t.props.children === label))!;
const draft = () => root.root.findByType('TextInput');
const mount = async () => act(async () => { root = create(React.createElement(ComposeScreen)); });
beforeEach(() => {
  vi.resetAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.params = { source: 'unlinked', profile: 'https://www.unlinked.ai/people/public-id', card: undefined };
  mocks.resolve.mockResolvedValue({ status: 'ready', recipient: { id: 'bob', name: 'Bob' } });
  mocks.create.mockResolvedValue({ id: 'dm' }); mocks.send.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root?.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('addresses the profile owner without contact search, starts blank and sends only on explicit Send', async () => {
  await mount();
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(mocks.params.profile);
  expect(mocks.contacts).not.toHaveBeenCalled();
  expect(draft().props.value).toBe(''); expect(button('Send message').props.disabled).toBe(true);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  await act(async () => draft().props.onChangeText('Hello Bob'));
  const send = button('Send message').props.onPress;
  await act(async () => { send(); send(); });
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(['bob'], { type: 'direct' });
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('dm', 'Hello Bob');
  expect(mocks.replace).toHaveBeenCalledWith('Chat', { conversationId: 'dm' });
});
it('offers an invite for an unclaimed contact without choosing an unrelated recipient', async () => {
  mocks.resolve.mockResolvedValue({ status: 'unclaimed', name: 'Alice' }); await mount();
  expect(root.root.findAllByType('TextInput')).toHaveLength(0);
  expect(button('Send message')).toBeUndefined();
  await act(async () => button('Get an invite link').props.onPress());
  expect(mocks.navigate).toHaveBeenCalledWith('MyCard');
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it('keeps failures distinct from unclaimed profiles and retries without sending', async () => {
  mocks.resolve.mockRejectedValueOnce(new Error('offline')); await mount();
  expect(button('Get an invite link')).toBeUndefined();
  expect(button('Send message')).toBeUndefined();
  await act(async () => button('Try again').props.onPress());
  expect(draft().props.value).toBe(''); expect(mocks.send).not.toHaveBeenCalled();
});
it('does not let a slow previous profile choose the new recipient', async () => {
  let resolve!: (value: unknown) => void;
  mocks.resolve.mockReturnValueOnce(new Promise(r => { resolve = r; })); await mount();
  mocks.params = { ...mocks.params, profile: 'https://www.unlinked.ai/people/b' };
  await act(async () => root.update(React.createElement(ComposeScreen)));
  await act(async () => resolve({ status: 'ready', recipient: { id: 'wrong', name: 'Wrong' } }));
  await act(async () => draft().props.onChangeText('Hello'));
  await act(async () => button('Send message').props.onPress());
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(['bob'], { type: 'direct' });
});
it('does not send an old draft after switching profiles while a conversation opens', async () => {
  let resolve!: (value: { id: string }) => void;
  mocks.create.mockReturnValueOnce(new Promise(r => { resolve = r; })); await mount();
  await act(async () => draft().props.onChangeText('Old draft'));
  await act(async () => { button('Send message').props.onPress(); });
  mocks.params = { ...mocks.params, profile: 'https://www.unlinked.ai/people/b' };
  await act(async () => root.update(React.createElement(ComposeScreen)));
  await act(async () => resolve({ id: 'old-dm' }));
  expect(draft().props.value).toBe(''); expect(mocks.send).not.toHaveBeenCalled();
});
it('reuses the conversation after a failed send and retains the draft', async () => {
  mocks.send.mockRejectedValueOnce(new Error('Offline')); await mount();
  await act(async () => draft().props.onChangeText('Keep this'));
  await act(async () => button('Send message').props.onPress());
  expect(draft().props.value).toBe('Keep this');
  await act(async () => button('Send message').props.onPress());
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(2);
});
it('still resolves explicit OpenChat cards and cancel leaves messages unsent', async () => {
  mocks.params.card = 'a'.repeat(24);
  mocks.card.mockResolvedValue({ name: 'Card owner' }); mocks.status.mockResolvedValue({ userId: 'owner' });
  await mount(); expect(mocks.resolve).not.toHaveBeenCalled();
  await act(async () => button('Cancel').props.onPress());
  expect(mocks.goBack).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled();
});
