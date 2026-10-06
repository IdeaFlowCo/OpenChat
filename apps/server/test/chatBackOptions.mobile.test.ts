import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', () => ({ Platform: platform, Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity', StyleSheet: { create: (value: unknown) => value } }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { chatBackOptions } from '../../mobile/src/navigation/chatBackOptions';
let root: ReturnType<typeof create> | undefined;
beforeEach(() => { platform.OS = 'web'; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it.each(['Search', 'NewConversation', 'InvitePerson', 'Compose', 'ContactProfile', 'ScanQr'])('%s has a visible Back that returns one level without opening a chat', async route => {
  const navigation = { getState: () => ({ index: 2 }), goBack: vi.fn(), navigate: vi.fn() };
  const options = chatBackOptions(route, navigation as any, '#444');
  await act(async () => { root = create(React.createElement(options.headerLeft as React.ComponentType)); });
  const button = root!.root.findByType('TouchableOpacity');
  expect(button.props.accessibilityLabel).toBe('Back');
  expect(button.findByType('Text').props.children).toBe('Back');
  await act(async () => button.props.onPress());
  expect(navigation.goBack).toHaveBeenCalledOnce(); expect(navigation.navigate).not.toHaveBeenCalled();
});
it('falls back to Chats rather than leaving the embedded app when local history is empty', async () => {
  const navigation = { getState: () => ({ index: 0 }), goBack: vi.fn(), navigate: vi.fn() };
  const options = chatBackOptions('Search', navigation as any, '#444');
  await act(async () => { root = create(React.createElement(options.headerLeft as React.ComponentType)); });
  await act(async () => root!.root.findByType('TouchableOpacity').props.onPress());
  expect(navigation.navigate).toHaveBeenCalledWith('Conversations'); expect(navigation.goBack).not.toHaveBeenCalled();
});
it('does not add Back to the inbox or replace native navigation', () => {
  expect(chatBackOptions('Conversations', {} as any, '#444')).toEqual({});
  platform.OS = 'ios'; expect(chatBackOptions('Search', {} as any, '#444')).toEqual({});
});
