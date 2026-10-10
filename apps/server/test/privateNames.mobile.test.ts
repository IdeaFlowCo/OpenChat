import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  exactEmail: undefined as string | undefined, noConversation: false, userId: 'alice', targetId: 'bob', name: 'Official Bob', isBot: false,
  platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default }, getProfile: vi.fn(), get: vi.fn(), set: vi.fn(), clear: vi.fn(), navigate: vi.fn(),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, Platform: mocks.platform,
  ActivityIndicator: 'ActivityIndicator', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', ScrollView: 'ScrollView',
  Alert: { alert: vi.fn() },
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: mocks.navigate }), useRoute: () => ({ params: { userId: mocks.targetId, exactEmail: mocks.exactEmail } }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({
  currentUser: { userId: mocks.userId }, conversations: mocks.noConversation ? [] : [{ participants: [{ user: { id: mocks.targetId, name: mocks.name, isBot: mocks.isBot } }] }],
  presence: new Map(), createConversation: vi.fn(), refreshConversations: vi.fn(),
}) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContactProfile: mocks.getProfile, getPrivateName: mocks.get, setPrivateName: mocks.set, clearPrivateName: mocks.clear } }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/BotBadge', () => ({ BotBadge: () => null }));
vi.mock('../../mobile/src/components/ProfileActions', () => ({ ProfileActions: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
// The asks list and the private card have their own suites. The private name row lives
// inside the (collapsed) private card, so the stand-in renders just that row.
vi.mock('../../mobile/src/components/ProfileAsks', () => ({ ProfileAsks: () => null }));
vi.mock('../../mobile/src/components/PrivateGraph', () => ({ PrivateCard: ({ nameRow }: any) => nameRow ?? null }));
import { PrivateNamesProvider, usePrivateName } from '../../mobile/src/contexts/PrivateNamesContext.js';
import { ContactProfileScreen } from '../../mobile/src/screens/ContactProfileScreen.js';
import { ConversationHeaderContent } from '../../mobile/src/components/ConversationHeaderContent.js';
let root: ReturnType<typeof create> | undefined;
function Header() {
  const privateName = usePrivateName(mocks.targetId);
  return React.createElement(ConversationHeaderContent, {
    title: privateName.name || mocks.name, officialName: privateName.name ? mocks.name : undefined,
    avatarName: mocks.name, subtitle: 'Online', variant: 'person',
    onPress: () => mocks.navigate('ContactProfile', { userId: mocks.targetId }),
  });
}
const app = () => React.createElement(PrivateNamesProvider, null,
  React.createElement(ContactProfileScreen), React.createElement(Header));
async function render() { await act(async () => { if (root) root.update(app()); else root = create(app()); }); }
function text() { return JSON.stringify(root!.toJSON()); }
function button(label: string) {
  return root!.root.findAllByType('TouchableOpacity').find(node =>
    node.findAllByType('Text').some(child => child.props.children === label))!;
}
beforeEach(() => {
  vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.noConversation = false; mocks.exactEmail = undefined;
  mocks.getProfile.mockImplementation(async () => ({ id: mocks.targetId, name: mocks.name, isBot: mocks.isBot }));
  mocks.userId = 'alice'; mocks.targetId = 'bob'; mocks.name = 'Official Bob'; mocks.isBot = false;
  mocks.get.mockResolvedValue({ name: null });
  mocks.set.mockImplementation(async (_id: string, name: string) => ({ name }));
  mocks.clear.mockResolvedValue({ name: null });
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
describe('native and canonical web private names', () => {
  it.each(['ios', 'web'])('sets, edits and clears a private name while retaining official identity on %s', async platform => {
    mocks.platform.OS = platform;
    await render(); expect(text()).toContain('Official Bob');
    await act(async () => button('Set private name').props.onPress());
    await act(async () => root!.root.findByType('TextInput').props.onChangeText('Buddy'));
    expect(root!.root.findByType('TextInput').props.accessibilityLabel).toBe('Private name');
    await act(async () => button('Save private name').props.onPress());
    expect(mocks.set).toHaveBeenCalledWith('bob', 'Buddy', undefined);
    expect(text()).toContain('Buddy'); expect(text()).toContain('OpenChat name: '); expect(text()).toContain('Official Bob');
    const headerButton = root!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel?.includes('Conversation information'))!;
    expect(headerButton.props.accessibilityLabel).toContain('Buddy. OpenChat name: Official Bob');
    await act(async () => headerButton.props.onPress());
    expect(mocks.navigate).toHaveBeenCalledWith('ContactProfile', { userId: 'bob' });
    mocks.name = 'Updated Bob'; await render();
    expect(text()).toContain('Buddy'); expect(text()).toContain('Updated Bob');
    await act(async () => button('Edit private name').props.onPress());
    expect(root!.root.findByType('TextInput').props.value).toBe('Buddy');
    await act(async () => root!.root.findByType('TextInput').props.onChangeText('Best Buddy'));
    await act(async () => button('Save private name').props.onPress());
    expect(text()).toContain('Best Buddy');
    await act(async () => button('Edit private name').props.onPress());
    await act(async () => button('Clear private name').props.onPress());
    expect(mocks.clear).toHaveBeenCalledWith('bob');
    expect(text()).not.toContain('Best Buddy'); expect(text()).toContain('Updated Bob');
    expect(button('Set private name')).toBeDefined();
  });
  it('does not leak the prior account or a late lookup into another account', async () => {
    let resolve: (value: { name: string }) => void = () => {};
    mocks.get.mockImplementation(() => new Promise(r => { resolve = r; }));
    await render(); const late = resolve;
    mocks.userId = 'mallory'; mocks.get.mockResolvedValue({ name: null }); await render();
    await act(async () => late({ name: 'Alice secret' }));
    expect(text()).not.toContain('Alice secret'); expect(text()).toContain('Official Bob');
  });
  it('surfaces save failure without claiming a changed name', async () => {
    mocks.set.mockRejectedValue(new Error('Person unavailable'));
    await render(); await act(async () => button('Set private name').props.onPress());
    await act(async () => root!.root.findByType('TextInput').props.onChangeText('Buddy'));
    await act(async () => button('Save private name').props.onPress());
    expect(root!.root.findAllByType('Text').some(n => n.props.accessibilityRole === 'alert' && n.props.children === 'Person unavailable')).toBe(true);
    expect(text()).toContain('Official Bob'); expect(button('Save private name')).toBeDefined();
  });
  it.each(['ios', 'web'])('loads and names a visible canonical person with no DM on %s', async platform => {
    mocks.platform.OS = platform; mocks.noConversation = true;
    await render();
    expect(mocks.getProfile).toHaveBeenCalledWith('bob', undefined);
    expect(text()).toContain('Official Bob');
    await act(async () => button('Set private name').props.onPress());
    await act(async () => root!.root.findByType('TextInput').props.onChangeText('No DM needed'));
    await act(async () => button('Save private name').props.onPress());
    expect(mocks.set).toHaveBeenCalledWith('bob', 'No DM needed', undefined);
    expect(text()).toContain('No DM needed'); expect(text()).toContain('Official Bob');
    await act(async () => button('Edit private name').props.onPress());
    await act(async () => button('Clear private name').props.onPress());
    expect(mocks.clear).toHaveBeenCalledWith('bob'); expect(button('Set private name')).toBeDefined();
  });
  it('does not keep a cached profile or editor after a denied identity lookup', async () => {
    mocks.getProfile.mockRejectedValue(new Error('Person unavailable'));
    await render();
    expect(text()).toContain('Person unavailable');
    expect(button('Set private name')).toBeUndefined();
  });
  it('offers no alias editor for yourself', async () => { mocks.targetId = 'alice'; await render(); expect(button('Set private name')).toBeUndefined(); });
  it('offers no alias editor for a bot', async () => { mocks.isBot = true; await render(); expect(button('Set private name')).toBeUndefined(); });
});

it('shows their card layer (headline, links) only when the profile carries it', async () => {
  mocks.noConversation = true;
  await act(async () => { root = create(React.createElement(PrivateNamesProvider, null, React.createElement(ContactProfileScreen))); });
  expect(text()).not.toContain('LinkedIn');
  await act(async () => root!.unmount()); root = undefined;
  mocks.getProfile.mockResolvedValue({ id: 'bob', name: 'Official Bob', isBot: false, card: { name: 'Official Bob', isBot: false, headline: 'Builds quiet tools', avatarUrl: null, status: null, linkedIn: 'https://www.linkedin.com/in/bob-example', x: null, link: null } });
  await act(async () => { root = create(React.createElement(PrivateNamesProvider, null, React.createElement(ContactProfileScreen))); });
  expect(text()).toContain('Builds quiet tools');
  expect(text()).toContain('LinkedIn');
  expect(text()).toContain('linkedin.com/in/bob-example');
  expect(text()).not.toContain('Website');
});

it.each(['ios', 'web'])('uses search proof for no-conversation profile and alias operations on %s', async platform => {
  mocks.platform.OS = platform; mocks.noConversation = true; mocks.exactEmail = 'bob@example.test';
  await act(async () => { root = create(React.createElement(PrivateNamesProvider, null, React.createElement(ContactProfileScreen))); });
  expect(mocks.getProfile).toHaveBeenCalledWith('bob', 'bob@example.test');
  expect(mocks.get).toHaveBeenCalledWith('bob', 'bob@example.test');
  await act(async () => button('Set private name').props.onPress());
  await act(async () => root!.root.findByType('TextInput').props.onChangeText('Buddy'));
  await act(async () => button('Save private name').props.onPress());
  expect(mocks.set).toHaveBeenCalledWith('bob', 'Buddy', 'bob@example.test');
  expect(text()).toContain('Official Bob');
  await act(async () => button('Edit private name').props.onPress());
  await act(async () => button('Clear private name').props.onPress());
  expect(mocks.clear).toHaveBeenCalledWith('bob');
});
