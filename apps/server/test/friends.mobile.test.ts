import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  route: { params: { token: 'card-token' } },
  navigation: { replace: vi.fn(), canGoBack: vi.fn(() => false), goBack: vi.fn() },
  clearEntry: vi.fn(),
  createConversation: vi.fn(),
  getPublicCard: vi.fn(),
  getCardFriendStatus: vi.fn(),
  requestCardFriend: vi.fn(),
  changeFriend: vi.fn(),
  addFromCard: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    ActivityIndicator: 'ActivityIndicator',
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
  };
});
vi.mock('@react-navigation/native', () => ({ useNavigation: () => mocks.navigation, useRoute: () => mocks.route }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ createConversation: mocks.createConversation }) }));
vi.mock('../../mobile/src/contexts/EntryContext', () => ({ useEntryContext: () => ({ clearEntry: mocks.clearEntry }) }));
vi.mock('../../mobile/src/theme/colors', () => ({ getColors: () => ({ background: '#fff', primary: '#123', onPrimary: '#fff', textPrimary: '#123', textSecondary: '#456', textMetadata: '#456', danger: '#c00' }) }));
vi.mock('../../mobile/src/api/client', () => ({
  ApiError: class ApiError extends Error { constructor(public status: number) { super('API error'); } },
  api: {
    getPublicCard: mocks.getPublicCard,
    getCardFriendStatus: mocks.getCardFriendStatus,
    requestCardFriend: mocks.requestCardFriend,
    changeFriend: mocks.changeFriend,
    addFromCard: mocks.addFromCard,
  },
}));
vi.mock('../../mobile/src/components/AddMeCardView', () => ({ AddMeCardView: () => React.createElement('CardPreview') }));

import { CardEntryScreen } from '../../mobile/src/screens/CardEntryScreen.js';

let root: ReturnType<typeof create> | undefined;
function button(label: string): ReactTestInstance {
  const candidate = root!.root.findAllByType('TouchableOpacity').find(node =>
    node.findAllByType('Text').some(text => String(text.props.children).includes(label)));
  if (!candidate) throw new Error(`Missing button: ${label}`);
  return candidate;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.getPublicCard.mockResolvedValue({ name: 'Bob' });
  mocks.getCardFriendStatus.mockResolvedValue({ userId: 'bob', state: 'none', updatedAt: null });
  mocks.requestCardFriend.mockResolvedValue({ userId: 'bob', state: 'outgoing', updatedAt: 'now' });
  mocks.changeFriend.mockResolvedValue({ userId: 'bob', state: 'friends', updatedAt: 'now' });
  mocks.createConversation.mockResolvedValue({ id: 'dm-bob' });
  mocks.clearEntry.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('card friend flow in the canonical mobile client', () => {
  it('sends an explicit request without opening a DM or calling the legacy add endpoint', async () => {
    await act(async () => { root = create(React.createElement(CardEntryScreen)); });
    await act(async () => { button('Add Bob as a friend').props.onPress(); });
    expect(mocks.requestCardFriend).toHaveBeenCalledWith('card-token');
    expect(mocks.addFromCard).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.navigation.replace).not.toHaveBeenCalled();
    expect(button('Cancel friend request')).toBeDefined();
  });

  it('accepts a crossed incoming request before offering Message', async () => {
    mocks.getCardFriendStatus.mockResolvedValue({ userId: 'bob', state: 'incoming', updatedAt: 'now' });
    await act(async () => { root = create(React.createElement(CardEntryScreen)); });
    await act(async () => { button('Accept friend request').props.onPress(); });
    expect(mocks.changeFriend).toHaveBeenCalledWith('bob', 'accept');
    expect(mocks.createConversation).not.toHaveBeenCalled();
    await act(async () => { button('Message').props.onPress(); });
    expect(mocks.createConversation).toHaveBeenCalledWith(['bob'], { type: 'direct' });
    expect(mocks.navigation.replace).toHaveBeenCalledWith('Chat', { conversationId: 'dm-bob' });
  });
});
