import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ copy: vi.fn(), alert: vi.fn(), dismiss: vi.fn(), copied: vi.fn() }));
vi.mock('react-native', () => ({
  Alert: { alert: mocks.alert }, Clipboard: { setString: vi.fn() }, Platform: { OS: 'web' },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/ReactionPicker', () => ({ ReactionPicker: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/components/MessageLinkActions', () => ({ MessageLinkActions: () => null }));
import { MessageActionSheet } from '../../mobile/src/components/MessageActionSheet';
let screen: ReturnType<typeof create>;
beforeEach(() => { vi.resetAllMocks(); mocks.copy.mockResolvedValue(true); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => screen?.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
const mount = async (deleted = false) => act(async () => { screen = create(React.createElement(MessageActionSheet, {
  visible: true, message: { id: 'synthetic-message', conversationId: 'synthetic-chat', content: '', deletedAt: deleted ? '2026-01-01' : undefined, senderId: 'synthetic-sender', createdAt: '2026-01-01', attachments: [] },
  isOwn: false, senderName: 'Synthetic sender', onDismiss: mocks.dismiss, onCopiedReference: mocks.copied,
  onReply: vi.fn(), onForward: vi.fn(), onForwardToAssistant: vi.fn(), onAskAssistant: vi.fn(), onSaveToThoughts: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onReact: vi.fn(), onBlock: vi.fn(), onReport: vi.fn(),
} as any)); });
const press = async (label: string) => act(async () => { await screen.root.findByProps({ accessibilityLabel: label }).props.onPress(); });

it.each([false, true])('offers stable copy link and ID for another sender, attachment-only or deleted message (deleted=%s)', async deleted => {
  await mount(deleted);
  await press('Copy link to message');
  expect(mocks.copy).toHaveBeenLastCalledWith('https://chat.ideaflow.app/app/message?id=synthetic-message');
  expect(mocks.copied).toHaveBeenLastCalledWith('Message link copied');
  await press('Copy message ID');
  expect(mocks.copy).toHaveBeenLastCalledWith('synthetic-message');
  expect(mocks.copied).toHaveBeenLastCalledWith('Message ID copied');
});
it('reports denied clipboard access without claiming success or dismissing the action', async () => {
  await mount(); mocks.copy.mockResolvedValue(false);
  await press('Copy link to message');
  expect(mocks.copied).not.toHaveBeenCalled(); expect(mocks.dismiss).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledWith('Could not copy', 'Please try again.');
});
