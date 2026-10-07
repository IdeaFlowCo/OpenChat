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
  privateName: null as string | null,
  platform: 'ios',
  focused: true,
  visibilityReleases: [] as ReturnType<typeof vi.fn>[],
}));

// Exercise the real ChatScreen hooks/render tree, with the OS boundary replaced
// by inert primitives. These tests check when we invoke native work, not whether
// a particular iOS/Hermes version crashes inside it.
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    Platform: { get OS() { return mocks.platform; }, select: (values: any) => values.ios ?? values.default },
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
  useFocusEffect: (fn: any) => React.useEffect(() => mocks.focused ? fn() : undefined, [fn, mocks.focused]),
  useNavigation: () => mocks.navigation, useRoute: () => mocks.route,
}));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => mocks.chat }));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({ useSocialExperience: () => ({ enhanced: false }) }));
vi.mock('../../mobile/src/contexts/RecordingContext', () => ({ useRecording: () => mocks.recording }));
vi.mock('../../mobile/src/contexts/PrivateNamesContext', () => ({ usePrivateName: (id?: string) => ({ name: id ? mocks.privateName : null }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: {} }));
vi.mock('../../mobile/src/services/notifications', () => ({ setActiveConversationForNotifications: vi.fn() }));
vi.mock('../../mobile/src/services/haptics', () => ({ hapticSend: vi.fn(), hapticReceive: mocks.receive }));
vi.mock('../../mobile/src/services/attachments', () => ({ pickImage: vi.fn(), uploadImage: vi.fn() }));
vi.mock('../../mobile/src/services/exportDownload', () => ({ saveJsonDownload: vi.fn() }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('../../mobile/src/services/hashtagSuggestions', () => ({
  fetchHashtagSuggestions: vi.fn(), invalidateHashtagSuggestions: vi.fn(),
}));
vi.mock('../../mobile/src/components/MessageActionSheet', () => ({ MessageActionSheet: (props: any) => React.createElement('MessageActionSheet', props) }));
vi.mock('../../mobile/src/components/ContextLane', () => ({ ContextLane: () => null }));
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
  mocks.privateName = null;
  mocks.platform = 'ios';
  mocks.focused = true;
  mocks.visibilityReleases = [];
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.chat = {
    currentUser: { userId: 'bob', name: 'Bob' },
    conversations: [{ id: 'sailing', type: 'group', title: 'Sailing Buddies', participants: [
      { user: { id: 'alice', name: 'Alice' }, role: 'owner' },
      { user: { id: 'bob', name: 'Bob' }, role: 'member' },
    ] } satisfies Conversation],
    messages: [], loadingMessages: false, isConnected: true,
    activeConversationId: 'sailing', activeConversationLane: 'chat',
    isChatVisible: (id: string) => mocks.chat.activeConversationId === id && mocks.chat.activeConversationLane === 'chat',
    registerConversationVisibility: vi.fn(() => {
      const release = vi.fn();
      mocks.visibilityReleases.push(release);
      return release;
    }),
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


describe('private direct-chat header labels', () => {
  it.each([false, true])('shows a viewer alias and official name with embedded=%s', async embedded => {
    mocks.chat.conversations[0].type = 'direct'; mocks.chat.conversations[0].title = undefined;
    mocks.privateName = 'My Alice';
    await act(async () => { screen = create(React.createElement(ChatScreen, { conversationId: 'sailing', embedded })); });
    if (!embedded) {
      const options = mocks.navigation.setOptions.mock.calls.at(-1)![0];
      await act(async () => { screen!.update(options.headerTitle()); });
    }
    expect(renderedText()).toContain('My Alice');
    expect(renderedText()).toContain('OpenChat name: Alice');
    const identity = screen!.root.findAllByType('TouchableOpacity').find(n => n.props.accessibilityLabel?.includes('Conversation information'))!;
    await act(async () => identity.props.onPress());
    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ContactProfile', { userId: 'alice' });
  });
});


describe('desktop composer input', () => {
  function key(flags: Record<string, unknown> = {}) {
    return { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: false,
      nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: vi.fn(), ...flags };
  }
  it('sends multiline text once and blocks pending/repeated/empty sends', async () => {
    mocks.platform = 'web';
    let resolve!: () => void;
    mocks.chat.sendMessage = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    await render();
    await act(async () => screen!.root.findByType('TextInput').props.onKeyDownCapture(key()));
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('One\nTwo'));
    const handler = screen!.root.findByType('TextInput').props.onKeyDownCapture;
    await act(async () => handler(key({ repeat: true })));
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    await act(async () => { handler(key()); handler(key()); });
    expect(mocks.chat.sendMessage).toHaveBeenCalledExactlyOnceWith('One\nTwo', undefined, undefined);
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Pending draft'));
    await act(async () => screen!.root.findByType('TextInput').props.onKeyDownCapture(key()));
    expect(mocks.chat.sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });
  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
    { nativeEvent: { isComposing: true, keyCode: 13 } },
    { nativeEvent: { isComposing: false, keyCode: 229 } }])('preserves modified/IME input: %j', async flags => {
    mocks.platform = 'web';
    mocks.chat.sendMessage = vi.fn();
    await render();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Unsent'));
    const event = key(flags);
    await act(async () => screen!.root.findByType('TextInput').props.onKeyDownCapture(event));
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('leaves native return intact and uses the long-press menu for web right-click', async () => {
    mocks.chat.messages = [message('context-target')];
    await render();
    expect(screen!.root.findByType('TextInput').props.onKeyDownCapture).toBeUndefined();
    mocks.platform = 'web';
    await render();
    const wrapper = screen!.root.findAllByType('View').find(node => node.props.onContextMenu)!;
    const bubble = wrapper.findAllByType('TouchableOpacity').find(node => node.props.onLongPress)!;
    const event = { preventDefault: vi.fn() };
    await act(async () => wrapper.props.onContextMenu(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const clicked = screen!.root.findByType('MessageActionSheet').props;
    expect(clicked.visible).toBe(true);
    expect(clicked.message.id).toBe('context-target');
    await act(async () => bubble.props.onLongPress());
    const held = screen!.root.findByType('MessageActionSheet').props;
    expect(held.message).toEqual(clicked.message);
    expect(held.isOwn).toBe(clicked.isOwn);
  });
});

it('restores the conversation when returning to an already-mounted chat', async () => {
  await render();
  mocks.focused = false; await render();
  mocks.focused = true; await render();
  expect(mocks.chat.setActiveConversation.mock.calls.map((call: any[]) => call[0])).toEqual(['sailing', 'sailing']);
});
it('leaves desktop selection and Context lane ownership with the parent', async () => {
  await act(async () => { screen = create(React.createElement(ChatScreen, { conversationId: 'sailing', embedded: true })); });
  await act(async () => screen!.update(React.createElement(ChatScreen, { conversationId: 'other', embedded: true })));
  expect(mocks.chat.setActiveConversation).not.toHaveBeenCalled();
});
it('shows Retry instead of an empty-conversation placeholder after a failed load', async () => {
  mocks.chat.messageLoadError = 'Could not load messages.'; mocks.chat.retryMessages = vi.fn();
  await render();
  expect(renderedText()).toContain('Could not load messages.');
  expect(renderedText()).not.toContain('Say hello');
  await act(async () => screen!.root.findByProps({ accessibilityLabel: 'Retry loading messages' }).props.onPress());
  expect(mocks.chat.retryMessages).toHaveBeenCalledOnce();
});


it('does not mark Chat read when a Context destination starts with stale lane state', async () => {
  mocks.route.params = { conversationId: 'sailing', lane: 'context' } as any;
  mocks.chat.setActiveConversation.mockImplementation((_id: string, opts: any) => {
    mocks.chat.activeConversationLane = opts?.lane ?? 'chat';
  });
  try {
    await render();
    expect(mocks.chat.markConversationRead).not.toHaveBeenCalled();
    mocks.chat.activeConversationId = 'sailing';
    mocks.chat.activeConversationLane = 'context';
    await render();
    expect(mocks.chat.markConversationRead).not.toHaveBeenCalled();
  } finally { mocks.route.params = { conversationId: 'sailing' }; }
});

it('preserves Context across focus return but honors a new explicit Chat destination', async () => {
  await render();
  mocks.chat.activeConversationLane = 'context'; await render();
  mocks.focused = false; await render();
  mocks.chat.activeConversationId = null; mocks.chat.activeConversationLane = 'chat';
  await render();
  mocks.focused = true; await render();
  expect(mocks.chat.setActiveConversation).toHaveBeenLastCalledWith('sailing', { lane: 'context' });
  mocks.route.params = { conversationId: 'sailing', lane: 'chat' } as any;
  await render();
  expect(mocks.chat.setActiveConversation).toHaveBeenLastCalledWith('sailing', { lane: 'chat' });
  mocks.route.params = { conversationId: 'sailing' };
});

it.each([
  { embedded: false, unmount: false }, { embedded: true, unmount: false }, { embedded: true, unmount: true },
])('releases visibility without clearing selection with embedded=$embedded and unmount=$unmount', async ({ embedded, unmount }) => {
  const element = React.createElement(ChatScreen, { conversationId: 'sailing', embedded });
  await act(async () => { screen = create(element); });
  expect(mocks.chat.registerConversationVisibility).toHaveBeenCalledExactlyOnceWith('sailing');
  const release = mocks.visibilityReleases[0];
  if (unmount) {
    await act(async () => screen!.unmount());
    screen = undefined;
  } else {
    mocks.focused = false;
    await act(async () => screen!.update(React.createElement(ChatScreen, { conversationId: 'sailing', embedded })));
  }
  expect(release).toHaveBeenCalledOnce();
  expect(mocks.chat.setActiveConversation).not.toHaveBeenCalledWith(null);
});
