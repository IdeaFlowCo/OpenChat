import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../../mobile/src/api/client.js';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, any>,
  recording: {} as Record<string, any>,
  navigation: { setOptions: vi.fn(), navigate: vi.fn() },
  route: { name: 'Chat', params: { conversationId: 'sailing' } },
  receive: vi.fn(),
  scroll: vi.fn(),
}));

// Exercise the real ChatScreen hooks/render tree, with the OS boundary replaced
// by inert primitives. These tests check when we invoke native work, not whether
// a particular iOS/Hermes version crashes inside it.
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    Appearance: { getColorScheme: () => 'light' },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
    Alert: { alert: vi.fn() },
    Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
    ActivityIndicator: 'ActivityIndicator', Image: 'Image',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View',
    Modal: ({ visible, children }: any) => visible ? children : null,
    FlatList: React.forwardRef(({ data, renderItem, ListEmptyComponent, ListHeaderComponent }: any, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: mocks.scroll }));
      return React.createElement('FlatList', null, ListHeaderComponent,
        data.length ? data.map((item: any, index: number) => React.createElement(
          React.Fragment, { key: item.key ?? item.userId }, renderItem({ item, index }),
        )) : ListEmptyComponent);
    }),
  };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => mocks.navigation, useRoute: () => mocks.route,
}));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => mocks.chat }));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({ useSocialExperience: () => ({ enhanced: false }) }));
vi.mock('../../mobile/src/contexts/RecordingContext', () => ({ useRecording: () => mocks.recording }));
vi.mock('../../mobile/src/api/client', () => ({ api: {} }));
vi.mock('../../mobile/src/services/notifications', () => ({ setActiveConversationForNotifications: vi.fn() }));
vi.mock('../../mobile/src/services/haptics', () => ({ hapticSend: vi.fn(), hapticReceive: mocks.receive }));
vi.mock('../../mobile/src/services/attachments', () => ({ pickImage: vi.fn(), uploadImage: vi.fn() }));
vi.mock('../../mobile/src/services/exportDownload', () => ({ saveJsonDownload: vi.fn() }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('../../mobile/src/services/hashtagSuggestions', () => ({
  fetchHashtagSuggestions: vi.fn(), invalidateHashtagSuggestions: vi.fn(),
}));
vi.mock('../../mobile/src/components/MessageActionSheet', () => ({ MessageActionSheet: () => null }));
vi.mock('../../mobile/src/components/ReactionsBar', () => ({ ReactionsBar: () => null }));
vi.mock('../../mobile/src/components/ToastMessage', () => ({ ToastMessage: () => null }));
vi.mock('../../mobile/src/components/AiDisclosureBanner', () => ({ AiDisclosureBanner: () => null }));
vi.mock('../../mobile/src/components/BotBadge', () => ({ BotBadge: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/components/NewMessagesPill', () => ({ NewMessagesPill: () => null }));
vi.mock('../../mobile/src/components/VoiceMessageBubble', () => ({ VoiceMessageBubble: () => null }));
vi.mock('../../mobile/src/components/HashtagAutocomplete', () => ({ HashtagAutocomplete: () => null }));
vi.mock('../../mobile/src/components/TransformButton', () => ({ TransformButton: () => null }));
vi.mock('../../mobile/src/components/NVCComposerModal', () => ({ NVCComposerModal: () => null }));
vi.mock('../../mobile/src/components/LinkPreviewCard', () => ({ LinkPreviewCard: () => null }));
vi.mock('../../mobile/src/components/AgentNetworkCard', () => ({ AgentNetworkCard: () => null }));
vi.mock('../../mobile/src/components/AgentOverlayButton', () => ({ AgentOverlayButton: () => null }));
vi.mock('../../mobile/src/components/ExportSheet', () => ({ ExportSheet: () => null }));

import { ChatScreen } from '../../mobile/src/screens/ChatScreen.js';

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id, content: `Message ${id}`, conversationId: 'sailing', senderId: 'alice',
    sender: { id: 'alice', name: 'Alice' }, createdAt: '2026-09-21T00:00:00Z', ...overrides,
  };
}

let screen: ReturnType<typeof create> | undefined;
async function render(conversationId = 'sailing') {
  await act(async () => {
    const element = React.createElement(ChatScreen, { conversationId });
    if (screen) screen.update(element);
    else screen = create(element);
  });
}
function renderedText() { return JSON.stringify(screen!.toJSON()); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.chat = {
    currentUser: { userId: 'bob', name: 'Bob' },
    conversations: [{ id: 'sailing', type: 'group', title: 'Sailing Buddies', participants: [
      { user: { id: 'alice', name: 'Alice' }, role: 'owner' },
      { user: { id: 'bob', name: 'Bob' }, role: 'member' },
    ] } satisfies Conversation],
    messages: [], loadingMessages: false, isConnected: true,
    setActiveConversation: vi.fn(), markConversationRead: vi.fn(),
    presence: new Map(), typingByConv: new Map(), readByOthers: new Map(), onlineUsers: new Map(),
    mutedConvs: {}, muteConv: vi.fn(), reportTyping: vi.fn(),
  };
  mocks.recording = {
    status: 'idle', conversationId: null, elapsedMs: 0, pressStartX: { current: 0 },
  };
});
afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  vi.useRealTimers();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('opening a group on the native client', () => {
  it('does not rewrite native header options on recorder ticks or composer keystrokes', async () => {
    await render();
    expect(mocks.navigation.setOptions).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 10; i++) {
      mocks.recording = { ...mocks.recording, elapsedMs: i * 100 };
      mocks.chat.presence = new Map([['unrelated-user', { status: 'available' }]]);
      await render();
    }
    await act(async () => {
      screen!.root.findByType('TextInput').props.onChangeText('hello');
    });
    expect(mocks.navigation.setOptions).toHaveBeenCalledTimes(1);
    mocks.chat.mutedConvs = { sailing: 'always' };
    await render();
    expect(mocks.navigation.setOptions).toHaveBeenCalledTimes(2);
  });

  it('does not send receive haptics for initial history, pagination, edits, or own messages', async () => {
    mocks.chat.loadingMessages = true;
    await render();
    mocks.chat.messages = [message('history')];
    mocks.chat.loadingMessages = false;
    await render();
    expect(mocks.receive).not.toHaveBeenCalled();
    mocks.chat.messages = [message('older'), ...mocks.chat.messages];
    await render();
    expect(mocks.receive).not.toHaveBeenCalled();
    mocks.chat.messages = [...mocks.chat.messages, message('new')];
    await render();
    expect(mocks.receive).toHaveBeenCalledTimes(1);
    mocks.chat.messages = mocks.chat.messages.map((m: Message) => ({ ...m, content: 'edited' }));
    await render();
    mocks.chat.messages = [...mocks.chat.messages, message('own', { senderId: 'bob' })];
    await render();
    expect(mocks.receive).toHaveBeenCalledTimes(1);
  });

  it('ignores another thread’s stale media on mount and silently loads the selected group', async () => {
    mocks.chat.messages = [message('stale', {
      conversationId: 'previous', attachments: [{ url: 'https://example.test/old.jpg', mimeType: 'image/jpeg' }],
    })];
    await render();
    expect(renderedText()).not.toContain('old.jpg');
    expect(mocks.receive).not.toHaveBeenCalled();
    mocks.chat.loadingMessages = true;
    await render();
    mocks.chat.messages = [message('history')];
    mocks.chat.loadingMessages = false;
    await render();
    expect(renderedText()).toContain('Message history');
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it('keeps first live-message feedback after an empty group finishes loading', async () => {
    mocks.chat.loadingMessages = true;
    await render();
    mocks.chat.loadingMessages = false;
    await render();
    mocks.chat.messages = [message('first-live')];
    await render();
    expect(mocks.receive).toHaveBeenCalledTimes(1);
  });

  it('does not send haptics for already-loaded history or when switching groups', async () => {
    mocks.chat.messages = [message('history')];
    await render();
    expect(mocks.receive).not.toHaveBeenCalled();
    mocks.chat.conversations.push({ ...mocks.chat.conversations[0], id: 'second' });
    await render('second');
    expect(renderedText()).not.toContain('Message history');
    mocks.chat.loadingMessages = true;
    await render('second');
    mocks.chat.messages = [message('second-history', { conversationId: 'second' })];
    mocks.chat.loadingMessages = false;
    await render('second');
    expect(mocks.receive).not.toHaveBeenCalled();
    mocks.chat.messages = [...mocks.chat.messages, message('second-live', { conversationId: 'second' })];
    await render('second');
    expect(mocks.receive).toHaveBeenCalledTimes(1);
  });

  it.each(['Sailing Buddies', undefined])('renders %s with missing participants and senders', async title => {
    mocks.chat.conversations[0] = {
      ...mocks.chat.conversations[0], title,
      participants: [null, { role: 'member' }, { user: null }, { user: {} },
        { user: { id: 'bob' } }, { user: { id: 'alice', name: 'Alice' } }],
    };
    await render(); // Also exercise ChatEmptyState’s untitled-group fallback.
    mocks.chat.messages = [message('missing-sender', {
      sender: undefined, senderId: undefined as unknown as string, replyToId: 'missing-reply',
    })];
    mocks.chat.typingByConv = new Map([['sailing', new Set(['unknown-user'])]]);
    await render();
    expect(renderedText()).toContain('OpenChat member');
    expect(renderedText()).toContain('Message missing-sender');
    expect(renderedText()).toContain('OpenChat member is typing');
    await act(async () => { screen!.root.findByType('TextInput').props.onChangeText('@'); });
    expect(renderedText()).toContain('Alice');
  });
});
