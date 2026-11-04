import React from 'react';
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ currentUser: { userId: 'alice' } as { userId: string } | null, navigate: vi.fn(), listAsks: vi.fn(), listIntentDrafts: vi.fn(), listMyStories: vi.fn(), getContextIntentions: vi.fn(), saveAsk: vi.fn(), updateAsk: vi.fn(), getAsk: vi.fn() }));
vi.mock('react-native', async () => {
  const React = await import('react');
  return { Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default }, StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390 }),
    Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Linking: { openURL: vi.fn() },
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }: any) => React.createElement('FlatList', null, ListHeaderComponent, data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: item.key }, renderItem({ item }))) : ListEmptyComponent) };
});
vi.mock('@react-navigation/native', () => ({ useFocusEffect: (fn: any) => React.useEffect(fn, [fn]), useNavigation: () => ({ navigate: mocks.navigate }), useRoute: () => ({ params: { askId: 'canonical-1' } }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('../../mobile/src/components/ContextIntentionControls', () => ({ IntentionLifecycleControls: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/api/client', () => ({ api: mocks }));
import { AsksScreen } from '../../mobile/src/screens/AsksScreen.js';
import { AskDetailScreen } from '../../mobile/src/screens/AskDetailScreen.js';
let root: ReturnType<typeof create>;
const text = () => root.root.findAllByType('Text').map(node => [node.props.children].flat(Infinity).filter(value => typeof value === 'string').join('')).join('\n');
const press = async (label: string) => { const node = root.root.findAllByType('TouchableOpacity').find(item => item.findAllByType('Text').some(value => [value.props.children].flat(Infinity).join('').includes(label)))!; expect(node).toBeDefined(); await act(async () => { node.props.onPress(); }); };
const source = { app: 'openchat', conversationId: 'agent-chat', messageId: 'source-message', itemIndex: 0, excerpt: 'Only synthetic Vlad: party invitees', assertion: 'stated', audienceIntent: 'Only synthetic Vlad', recordedAt: '2026-11-04T00:00:00Z' };
const ask = { id: 'canonical-1', text: 'Find party invitees', authorParty: { kind: 'self' }, fromMe: true, forMe: false, carrier: null, placements: [], status: 'open', horizon: 'short', recheckAfter: '2099-01-01', exposure: 'only_me', sources: [source] };
beforeEach(() => {
  vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.currentUser = { userId: 'alice' };
  mocks.listAsks.mockResolvedValue({ asks: [ask], truncated: false }); mocks.getAsk.mockResolvedValue({ ask });
  mocks.listIntentDrafts.mockResolvedValue([]); mocks.listMyStories.mockResolvedValue([]); mocks.getContextIntentions.mockResolvedValue({ intentions: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
describe('canonical All asks in the native client', () => {
  it('has a basic-mode Profile door and shared native/web screen routes', () => {
    const profile = readFileSync(new URL('../../mobile/src/screens/MyCardScreen.tsx', import.meta.url), 'utf8');
    expect(profile).toContain('title="All asks"'); expect(profile).toContain("navigation.navigate('AsksList')");
    const app = readFileSync(new URL('../../mobile/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<ChatsStack.Screen name="AsksList" component={AsksScreen}'); expect(app).toContain('<AsksStack.Screen name="AsksList" component={AsksScreen}');
    expect(app).toContain('<ChatsStack.Screen name="AskDetail"');
  });
  it('defaults to My asks, keeps archived access and intended audience honest, and opens stable source/detail routes', async () => {
    await act(async () => { root = create(React.createElement(AsksScreen)); });
    expect(mocks.listAsks).toHaveBeenCalledWith({ direction: 'from_me', status: 'all', q: '', limit: 200 });
    expect(text()).toContain('Only you can currently see this · intended for Only synthetic Vlad');
    await press('Details & sources'); expect(mocks.navigate).toHaveBeenLastCalledWith('AskDetail', { askId: 'canonical-1' });
    await press('Open source message'); expect(mocks.navigate).toHaveBeenLastCalledWith('Chat', { conversationId: 'agent-chat', entryId: 'source-message' });
    await press('Hide closed'); expect(mocks.listAsks).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'open,stale' }));
    await press('For me'); expect(mocks.listAsks).toHaveBeenLastCalledWith(expect.objectContaining({ direction: 'for_me', status: 'open,stale' }));
  });
  it('labels truncation and partial legacy failures; account switch clears previous owner rows immediately', async () => {
    mocks.listAsks.mockResolvedValue({ asks: [ask], truncated: true }); mocks.getContextIntentions.mockRejectedValue(new Error('Context source unavailable'));
    await act(async () => { root = create(React.createElement(AsksScreen)); });
    expect(text()).toContain('first 200 matching asks'); expect(text()).toContain('Context source unavailable');
    mocks.currentUser = { userId: 'bob' }; mocks.listAsks.mockReturnValue(new Promise(() => {}));
    await act(async () => { root.update(React.createElement(AsksScreen)); });
    expect(text()).not.toContain('Find party invitees'); expect(text()).not.toContain('Only synthetic Vlad');
  });
  it('does not reopen a previously fulfilled ask when saving duplicate text', async () => {
    mocks.saveAsk.mockResolvedValue({ created: false, ask: { ...ask, status: 'fulfilled' } });
    await act(async () => { root = create(React.createElement(AsksScreen)); });
    const input = root.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === 'Add one of your own asks')!;
    await act(async () => input.props.onChangeText('Find party invitees')); await press('Save');
    expect(mocks.updateAsk).not.toHaveBeenCalled();
  });
  it('renders source evidence and does not retain a detail across account switch', async () => {
    await act(async () => { root = create(React.createElement(AskDetailScreen)); });
    expect(text()).toContain(source.excerpt);
    mocks.currentUser = { userId: 'bob' }; mocks.getAsk.mockReturnValue(new Promise(() => {}));
    await act(async () => root.update(React.createElement(AskDetailScreen)));
    expect(text()).not.toContain(source.excerpt);
  });
});
