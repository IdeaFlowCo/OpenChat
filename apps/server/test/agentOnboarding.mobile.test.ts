import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ reveal: vi.fn(), copy: vi.fn(), addPost: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({
  Alert: { alert: mocks.alert }, Platform: { select: () => ({}) },
  StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({}), useRoute: () => ({ params: { keyId: 'existing' } }),
  useFocusEffect: (fn: any) => React.useEffect(fn, [fn]),
}));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/McpSetupCard', () => ({ McpSetupCard: () => null }));
vi.mock('../../mobile/src/api/client', () => ({
  OPENCHAT_URL: 'https://chat.globalbr.ai',
  api: { listAgentKeys: async () => [{ id: 'existing', name: 'Hermes', keyPrefix: 'oc_short', scopes: ['read','write'], createdAt: new Date().toISOString() }], revealAgentKey: mocks.reveal },
}));
vi.mock('../../mobile/src/services/contextLane', () => ({ contextLaneManager: { addPost: mocks.addPost } }));
import { AgentKeyDetailScreen } from '../../mobile/src/screens/AgentKeyDetailScreen';
import { ContextComposer } from '../../mobile/src/components/ContextComposer';
let tree: ReactTestRenderer;
beforeEach(() => { mocks.reveal.mockReset().mockResolvedValue({ key: 'oc_complete-existing-key' }); mocks.copy.mockReset().mockResolvedValue(true); mocks.addPost.mockReset(); mocks.alert.mockClear(); });
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });
const button = (label: string) => tree.root.findAllByType('TouchableOpacity' as any).find(n => n.findAllByType('Text' as any).some(t => t.children.join('') === label))!;
it('copies an existing full key repeatedly and never copies a truncated curl credential', async () => {
  await act(async () => { tree = create(React.createElement(AgentKeyDetailScreen)); });
  await act(async () => button('Copy curl snippet').props.onPress());
  expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringContaining('Bearer oc_complete-existing-key'));
  for (let i = 0; i < 2; i++) await act(async () => button('Copy API key').props.onPress());
  expect(mocks.copy).toHaveBeenLastCalledWith('oc_complete-existing-key');
  await act(async () => button('Copy setup with this key').props.onPress());
  expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringContaining('Authorization: Bearer oc_complete-existing-key'));
  expect(mocks.alert).not.toHaveBeenCalled();
});
it('shows a posting error and preserves the draft and retry ID until a successful post', async () => {
  mocks.addPost.mockRejectedValueOnce(new Error('Not authorized to write to this context lane')).mockResolvedValueOnce({});
  await act(async () => { tree = create(React.createElement(ContextComposer, { conversationId: 'room' })); });
  await act(async () => tree.root.findByType('TextInput' as any).props.onChangeText('Keep this draft'));
  await act(async () => button('Post').props.onPress());
  expect(tree.root.findByProps({ accessibilityRole: 'alert' }).children.join('')).toContain('Not authorized');
  expect(tree.root.findByType('TextInput' as any).props.value).toBe('Keep this draft');
  await act(async () => button('Post').props.onPress());
  expect(mocks.addPost.mock.calls[0]).toEqual(mocks.addPost.mock.calls[1]);
  expect(tree.root.findByType('TextInput' as any).props.value).toBe('');
});
