import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../../mobile/src/api/client.js';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, any>,
  recording: {} as Record<string, any>,
  vision: {saveToVision:vi.fn(),reviewVisionSave:vi.fn(),connectVision:vi.fn()},
  uuid:vi.fn(()=>'synthetic-fresh-attempt'),
  navigation: { setOptions: vi.fn(), navigate: vi.fn() },
  route: { name: 'Chat', params: { conversationId: 'sailing' } },
  receive: vi.fn(),
  scroll: vi.fn(),
  keyboardEvents: new Map<string, () => void>(),
  appStateEvents: new Set<(state: string) => void>(),
  inputFocused: false,
  appState: 'active',
  focusInput: vi.fn(() => { mocks.inputFocused = true; }),
  setInputProps: vi.fn(),
  blurInput: vi.fn(() => { mocks.inputFocused = false; }),
  privateName: null as string | null,
  platform: 'ios',
  focused: true,
  visibilityReleases: [] as ReturnType<typeof vi.fn>[],
  windowWidth: 390,
  safeBottom: 34,
  stackIndex: 1,
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
    Animated: {
      View: 'Animated.View',
      Value: class { constructor(public value: number) {} setValue() {} stopAnimation() {} interpolate() { return this; } },
      timing: () => ({ start: vi.fn() }), spring: () => ({ start: vi.fn() }), sequence: () => ({ start: vi.fn() }),
    },
    Easing: { out: (fn: unknown) => fn, quad: (t: number) => t },
    Pressable: 'Pressable',
    AppState: {
      get currentState() { return mocks.appState; },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        mocks.appStateEvents.add(listener);
        return { remove: () => mocks.appStateEvents.delete(listener) };
      },
    },
    Keyboard: { addListener: (event: string, listener: () => void) => {
      mocks.keyboardEvents.set(event, listener);
      return { remove: () => mocks.keyboardEvents.delete(event) };
    } },
    ActivityIndicator: 'ActivityIndicator', Image: 'Image', ScrollView: 'ScrollView',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    useWindowDimensions: () => ({ width: mocks.windowWidth, height: 844 }),
    Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
    TextInput: React.forwardRef((props: any, ref) => {
      React.useImperativeHandle(ref, () => ({
        isFocused: () => mocks.inputFocused,
        blur: mocks.blurInput,
        focus: mocks.focusInput,
        setNativeProps: mocks.setInputProps,
      }));
      return React.createElement('TextInput', props);
    }),
    Modal: ({ visible, children }: any) => visible ? children : null,
    FlatList: React.forwardRef(({ data, renderItem, ListEmptyComponent, ListHeaderComponent, keyboardDismissMode, onScrollBeginDrag }: any, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: mocks.scroll }));
      return React.createElement('FlatList', { keyboardDismissMode, onScrollBeginDrag }, ListHeaderComponent,
        data.length ? data.map((item: any, index: number) => React.createElement(
          React.Fragment, { key: item.key ?? item.userId }, renderItem({ item, index }),
        )) : ListEmptyComponent);
    }),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: mocks.safeBottom, left: 0 }) }));
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (fn: any) => React.useEffect(() => mocks.focused ? fn() : undefined, [fn, mocks.focused]),
  useNavigation: () => mocks.navigation,
  useNavigationState: (select: (state: { index: number }) => number) => select({ index: mocks.stackIndex }), useRoute: () => mocks.route,
}));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => mocks.chat }));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({ useSocialExperience: () => ({ enhanced: false }) }));
vi.mock('../../mobile/src/contexts/RecordingContext', () => ({ useRecording: () => mocks.recording }));
vi.mock('../../mobile/src/contexts/PrivateNamesContext', () => ({ usePrivateName: (id?: string) => ({ name: id ? mocks.privateName : null }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: mocks.vision }));
vi.mock('expo-crypto',async()=>{const {createHash}=await import('node:crypto');return {CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(_algorithm:string,value:string)=>createHash('sha256').update(value).digest('hex'),randomUUID:mocks.uuid};});
vi.mock('../../mobile/src/services/notifications', () => ({ setActiveConversationForNotifications: vi.fn() }));
vi.mock('../../mobile/src/services/haptics', () => ({ hapticSend: vi.fn(), hapticReceive: mocks.receive, hapticGrowTick: vi.fn(), hapticTickle: vi.fn() }));
vi.mock('../../mobile/src/services/attachments', () => ({ MAX_IMAGES_PER_MESSAGE: 10, pickDocumentWeb: vi.fn(), uploadFile: vi.fn(), FileUploadError: class extends Error {}, pickImages: vi.fn(async () => []), takePhoto: vi.fn(async () => null), filesToAssets: vi.fn(async () => []), releaseAsset: vi.fn(), uploadImage: vi.fn(), uploadImages: vi.fn(async () => ({ uploaded: [], failed: [] })), checkPhotosForSend: vi.fn(async (assets: any[]) => ({ ok: assets, rejected: [] })) }));
vi.mock('../../mobile/src/services/photoActions', () => ({ photoActionLabel: 'Save', saveOrSharePhoto: vi.fn(), savePhotos: vi.fn(), sharePhoto: vi.fn(), describeSaveResult: () => '', normalizeRotation: (d?: number) => d ?? 0, canRotateFiles: async () => false, rotateImageFile: async () => null, PhotoSaveError: class extends Error {} }));
vi.mock('../../mobile/src/services/exportDownload', () => ({ saveJsonDownload: vi.fn() }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn(), logInfo: vi.fn() }));
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
vi.mock('../../mobile/src/components/JumpToBottomButton', () => ({ JumpToBottomButton: () => null }));
vi.mock('../../mobile/src/components/VoiceMessageBubble', () => ({ VoiceMessageBubble: () => null }));
vi.mock('../../mobile/src/components/HashtagAutocomplete', () => ({ HashtagAutocomplete: (props: any) => React.createElement('HashtagAutocomplete', props) }));
vi.mock('../../mobile/src/components/TransformButton', () => ({ TransformButton: () => null }));
vi.mock('../../mobile/src/components/NVCComposerModal', () => ({ NVCComposerModal: (props: any) => React.createElement('NVCComposerModal', props) }));
vi.mock('../../mobile/src/components/LinkPreviewCard', () => ({ LinkPreviewCard: () => null }));
vi.mock('../../mobile/src/components/AgentNetworkCard', () => ({ AgentNetworkCard: () => null }));
vi.mock('../../mobile/src/components/AgentOverlayButton', () => ({ AgentOverlayButton: () => null }));
vi.mock('../../mobile/src/components/ExportSheet', () => ({ ExportSheet: () => null }));

import { pickDocumentWeb, uploadFile, pickImages, checkPhotosForSend } from '../../mobile/src/services/attachments';
import { Alert } from 'react-native';
import { fetchHashtagSuggestions } from '../../mobile/src/services/hashtagSuggestions';
import { ApiError, errorFromResponse } from '../../mobile/src/api/errors';
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
  mocks.windowWidth = 390;
  mocks.safeBottom = 34;
  mocks.stackIndex = 1;
  mocks.focused = true;
  mocks.inputFocused = false;
  mocks.appState = 'active';
  mocks.keyboardEvents.clear();
  mocks.appStateEvents.clear();
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
    setActiveConversation: vi.fn(), markConversationRead: vi.fn(), sendMessageToConversation: vi.fn(async()=>{}),
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('phone thread bottom edge', () => {
  const inset = () => screen!.root.findAll(node => node.props.testID === 'composer-home-indicator-inset' && node.type === 'View');
  const avoidanceOffset = () => screen!.root.findByType('KeyboardAvoidingView').props.keyboardVerticalOffset;

  it('clears the home indicator under the composer and lets the keyboard cover that strip', async () => {
    await render();
    expect(inset()).toHaveLength(1);
    expect(inset()[0].props.style.height).toBe(34);
    // Header height 56 until the screen is measured, lowered by the same 34.
    expect(avoidanceOffset()).toBe(22);
  });

  it.each([
    ['the tab bar shows (thread is the stack root)', () => { mocks.stackIndex = 0; }],
    ['a tablet-width window keeps the tab bar', () => { mocks.windowWidth = 820; }],
    ['Android', () => { mocks.platform = 'android'; }],
    ['web', () => { mocks.platform = 'web'; }],
    ['no home indicator', () => { mocks.safeBottom = 0; }],
  ])('adds nothing when %s', async (_case, arrange) => {
    arrange();
    await render();
    expect(inset()).toHaveLength(0);
    if (mocks.platform === 'ios') expect(avoidanceOffset()).toBe(56);
  });

  it('drops the strip when the thread becomes the stack root again', async () => {
    await render();
    expect(inset()).toHaveLength(1);
    mocks.stackIndex = 0;
    await render();
    expect(inset()).toHaveLength(0);
  });

  it('uses the same phone breakpoint App.tsx hides the tab bar at', async () => {
    const { readFile } = await import('node:fs/promises');
    const { PHONE_THREAD_MAX_WIDTH } = await import('../../mobile/src/utils/threadChrome');
    const app = await readFile(new URL('../../mobile/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain(`const narrow = width < ${PHONE_THREAD_MAX_WIDTH};`);
    expect(app).toContain('const hideInThread = narrow && chatCanGoBack(navState);');
  });

  it('adds nothing in the embedded wide pane', async () => {
    await act(async () => { screen = create(React.createElement(ChatScreen, { conversationId: 'sailing', embedded: true })); });
    expect(inset()).toHaveLength(0);
    expect(avoidanceOffset()).toBe(0);
  });
});

describe('chat keyboard lifecycle', () => {
  async function openKeyboard() {
    mocks.inputFocused = true;
    await act(async () => {
      if (mocks.platform === 'ios') mocks.keyboardEvents.get('keyboardWillShow')?.();
      mocks.keyboardEvents.get('keyboardDidShow')?.();
    });
  }

  function hideButton() {
    return screen!.root.findAll(node => node.type === 'TouchableOpacity' && node.props.accessibilityLabel === 'Hide keyboard');
  }

  it.each([['ios', 'interactive'], ['android', 'on-drag']])('uses %s list dismissal', async (platform, mode) => {
    mocks.platform = platform;
    await render();
    expect(screen!.root.findByType('FlatList').props.keyboardDismissMode).toBe(mode);
  });

  it('blurs only the focused composer when navigation leaves a mounted chat', async () => {
    await render();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Retained draft'));
    await openKeyboard();
    expect(hideButton()).toHaveLength(1);
    mocks.scroll.mockClear();
    mocks.focused = false;
    await render();
    expect(mocks.blurInput).toHaveBeenCalledOnce();
    expect(hideButton()).toHaveLength(0);
    expect(mocks.appStateEvents.size).toBe(0);
    expect(mocks.keyboardEvents.size).toBe(0);
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(mocks.scroll).not.toHaveBeenCalled();
    mocks.focused = true;
    await render();
    expect(screen!.root.findByType('TextInput').props.value).toBe('Retained draft');
    expect(mocks.inputFocused).toBe(false);
  });

  it('dismisses on background, retains the draft and does not reopen on resume', async () => {
    await render();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Background draft'));
    await openKeyboard();
    await act(async () => mocks.appStateEvents.forEach(listener => listener('inactive')));
    expect(mocks.blurInput).not.toHaveBeenCalled();
    await act(async () => mocks.appStateEvents.forEach(listener => listener('background')));
    await act(async () => mocks.appStateEvents.forEach(listener => listener('active')));
    expect(mocks.blurInput).toHaveBeenCalledOnce();
    expect(hideButton()).toHaveLength(0);
    expect(screen!.root.findByType('TextInput').props.value).toBe('Background draft');
    expect(mocks.inputFocused).toBe(false);
  });

  it('cancels the pending scroll-to-latest when a user begins dragging', async () => {
    await render();
    mocks.scroll.mockClear();
    await openKeyboard();
    await act(async () => screen!.root.findByType('FlatList').props.onScrollBeginDrag());
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(mocks.scroll).not.toHaveBeenCalled();
  });

  it('keeps the iOS hide button until a keyboard dismissal completes', async () => {
    await render();
    await openKeyboard();
    await act(async () => { mocks.keyboardEvents.get('keyboardWillHide')?.(); });
    expect(hideButton()).toHaveLength(1);
    await act(async () => { mocks.keyboardEvents.get('keyboardDidHide')?.(); });
    expect(hideButton()).toHaveLength(0);
  });

  it('ignores keyboard events for an input other than the chat composer', async () => {
    await render();
    mocks.scroll.mockClear();
    await act(async () => {
      mocks.keyboardEvents.get('keyboardWillShow')?.();
      mocks.keyboardEvents.get('keyboardDidShow')?.();
      vi.advanceTimersByTime(50);
    });
    expect(hideButton()).toHaveLength(0);
    expect(mocks.scroll).not.toHaveBeenCalled();
  });

  it('keeps the input open and clears text after a synthetic send', async () => {
    await render();
    await openKeyboard();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Synthetic send'));
    const send = screen!.root.find(node => node.type === 'TouchableOpacity' && node.props.accessibilityLabel === 'Send message');
    await act(async () => { await send.props.onPress(); });
    expect(mocks.chat.sendMessageToConversation).toHaveBeenCalledWith('sailing', 'Synthetic send', undefined, undefined, undefined, { assistantScope: 'universal' });
    expect(screen!.root.findByType('TextInput').props.value).toBe('');
    expect(mocks.inputFocused).toBe(true);
    expect(mocks.blurInput).not.toHaveBeenCalled();
  });
});

describe('deferred native composer refocus', () => {
  const suggestion = { tag: 'design', source: 'chat' as const, ownCount: 0, chatCount: 1 };

  async function selectHashtag() {
    vi.mocked(fetchHashtagSuggestions).mockResolvedValueOnce([suggestion]);
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('#de'));
    await act(async () => { vi.advanceTimersByTime(160); });
    await act(async () => screen!.root.findByType('HashtagAutocomplete').props.onSelect(suggestion));
  }

  const actions = [
    {
      label: 'Reply',
      run: async () => act(async () => screen!.root.findByType('MessageActionSheet').props.onReply({
        messageId: 'synthetic-message', senderId: 'alice', senderName: 'Alice', content: 'Fixture reply',
      })),
    },
    {
      label: 'NVC submit',
      run: async () => act(async () => screen!.root.findByType('NVCComposerModal').props.onSubmit('Fixture NVC draft')),
    },
    { label: 'hashtag selection', run: selectHashtag },
  ];

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  });

  async function setAppState(state: string) {
    mocks.appState = state;
    await act(async () => mocks.appStateEvents.forEach(listener => listener(state)));
  }

  it.each(actions)('cancels $label refocus across a fast navigation blur and return', async ({ run }) => {
    await render();
    await run();
    mocks.focused = false;
    await render();
    mocks.focused = true;
    await render();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mocks.focusInput).not.toHaveBeenCalled();
    expect(mocks.setInputProps).not.toHaveBeenCalled();
  });

  it.each(actions)('cancels $label refocus across a fast background and resume', async ({ run }) => {
    await render();
    await run();
    const draft = screen!.root.findByType('TextInput').props.value;
    await setAppState('background');
    await setAppState('active');
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mocks.focusInput).not.toHaveBeenCalled();
    expect(mocks.setInputProps).not.toHaveBeenCalled();
    expect(screen!.root.findByType('TextInput').props.value).toBe(draft);
  });

  it('keeps the draft without refocusing when NVC submits in the background', async () => {
    await render();
    const nvcSubmit = screen!.root.findByType('NVCComposerModal').props.onSubmit;
    await setAppState('background');
    await act(async () => nvcSubmit('Late NVC draft'));
    await setAppState('active');
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mocks.focusInput).not.toHaveBeenCalled();
    expect(screen!.root.findByType('TextInput').props.value).toBe('Late NVC draft');
  });

  it.each(actions)('still runs $label refocus while active', async ({ label, run }) => {
    await render();
    await run();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mocks.focusInput).toHaveBeenCalledOnce();
    if (label === 'hashtag selection') {
      expect(screen!.root.findByType('TextInput').props.value).toBe('#design ');
      expect(mocks.setInputProps).toHaveBeenCalledWith({ selection: { start: 8, end: 8 } });
    }
  });
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
    mocks.chat.sendMessageToConversation = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    await render();
    await act(async () => screen!.root.findByType('TextInput').props.onKeyDownCapture(key()));
    expect(mocks.chat.sendMessageToConversation).not.toHaveBeenCalled();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('One\nTwo'));
    const handler = screen!.root.findByType('TextInput').props.onKeyDownCapture;
    await act(async () => handler(key({ repeat: true })));
    expect(mocks.chat.sendMessageToConversation).not.toHaveBeenCalled();
    await act(async () => { handler(key()); handler(key()); });
    expect(mocks.chat.sendMessageToConversation).toHaveBeenCalledExactlyOnceWith('sailing', 'One\nTwo', undefined, undefined, undefined, {assistantScope:'universal'});
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Pending draft'));
    await act(async () => screen!.root.findByType('TextInput').props.onKeyDownCapture(key()));
    expect(mocks.chat.sendMessageToConversation).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });
  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
    { nativeEvent: { isComposing: true, keyCode: 13 } },
    { nativeEvent: { isComposing: false, keyCode: 229 } }])('preserves modified/IME input: %j', async flags => {
    mocks.platform = 'web';
    mocks.chat.sendMessageToConversation = vi.fn();
    await render();
    await act(async () => screen!.root.findByType('TextInput').props.onChangeText('Unsent'));
    const event = key(flags);
    await act(async () => screen!.root.findByType('TextInput').props.onKeyDownCapture(event));
    expect(mocks.chat.sendMessageToConversation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('leaves native return intact and uses the long-press menu for web right-click', async () => {
    mocks.chat.messages = [message('context-target')];
    await render();
    expect(screen!.root.findByType('TextInput').props.onKeyDownCapture).toBeUndefined();
    const nativeBubble = screen!.root.findAllByType('TouchableOpacity').find(node => node.props.onLongPress)!;
    await act(async () => nativeBubble.props.onLongPress());
    expect(screen!.root.findByType('MessageActionSheet').props.message.id).toBe('context-target');
    await act(async () => screen!.root.findByType('MessageActionSheet').props.onDismiss());
    mocks.platform = 'web';
    await render();
    const wrapper = screen!.root.findAllByType('View').find(node => node.props.onContextMenu)!;
    expect(wrapper.findAllByType('TouchableOpacity').some(node => node.props.onLongPress)).toBe(false);
    const event = { preventDefault: vi.fn() };
    await act(async () => wrapper.props.onContextMenu(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const clicked = screen!.root.findByType('MessageActionSheet').props;
    expect(clicked.visible).toBe(true);
    expect(clicked.message.id).toBe('context-target');
    await act(async () => screen!.root.findByProps({ accessibilityLabel: 'Message actions: Message context-target' }).props.onPress());
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

it('renders actionable links in the real message body and preserves link context menus', async () => {
  mocks.platform = 'web';
  mocks.chat.messages = [message('links', { content: 'Hi @Alice (https://example.com/a(b)). javascript:alert(1)' })];
  await render();
  const link = screen!.root.findByProps({ accessibilityRole: 'link' });
  expect(link.props.href).toBe('https://example.com/a(b)');
  expect(renderedText()).toContain('javascript:alert(1)');
  const wrapper = screen!.root.findAllByType('View').find(node => node.props.onContextMenu)!;
  const event = { target: { closest: () => ({}) }, preventDefault: vi.fn() };
  await act(async () => wrapper.props.onContextMenu(event));
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(screen!.root.findByType('MessageActionSheet').props.visible).toBe(false);
});

describe('attachment destination and scope during navigation',()=>{
  function prepareAssistant(){
    mocks.chat.conversations.push({id:'assistant-dm',type:'direct',participants:[{user:{id:'bob',name:'Bob'}},{user:{id:'assistant',name:'Assistant',isBot:true}}]});
    mocks.chat.assistantScopes={'assistant-dm':'conversation'};
    mocks.chat.sendMessage=vi.fn();
  }
  async function navigateDuringPreparation(){
    mocks.chat.activeConversationId='assistant-dm';
    await render('assistant-dm');
    expect(renderedText()).toContain('This chat only');
  }
  async function press(label:string){
    await act(async()=>{await screen!.root.findAllByType('TouchableOpacity').find(n=>n.props.accessibilityLabel===label)!.props.onPress();});
  }
  it('keeps a pending file caption in the group captured before upload',async()=>{
    mocks.platform='web';prepareAssistant();
    const file={name:'synthetic.txt',size:5};
    const attachment={url:'synthetic-file',type:'file',mimeType:'text/plain',filename:file.name};
    vi.mocked(pickDocumentWeb).mockResolvedValueOnce(file as File);
    let finish!:(value:any)=>void;
    vi.mocked(uploadFile).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await render();await press('Attach file');
    await act(async()=>{screen!.root.findByType('TextInput').props.onChangeText('group file caption');});
    let sending!:Promise<void>;
    await act(async()=>{sending=screen!.root.findAllByType('TouchableOpacity').find(n=>n.props.accessibilityLabel==='Send message')!.props.onPress();});
    await navigateDuringPreparation();
    await act(async()=>{finish(attachment);await sending;});
    expect(mocks.chat.sendMessageToConversation).toHaveBeenCalledExactlyOnceWith('sailing','group file caption',undefined,[attachment],undefined,{assistantScope:'universal'});
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });
  it('keeps photos and their caption in the group captured before photo checks',async()=>{
    mocks.platform='web';prepareAssistant();
    const photo={uri:'synthetic-photo',fileName:'synthetic.jpg',mimeType:'image/jpeg',width:2,height:2,fileSize:4};
    vi.mocked(pickImages).mockResolvedValueOnce([photo]);
    let finish!:(value:any)=>void;
    vi.mocked(checkPhotosForSend).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await render();await press('Attach image');
    await act(async()=>{screen!.root.findByType('TextInput').props.onChangeText('group photo caption');});
    let sending!:Promise<void>;
    await act(async()=>{sending=screen!.root.findAllByType('TouchableOpacity').find(n=>n.props.accessibilityLabel==='Send message')!.props.onPress();});
    await navigateDuringPreparation();
    await act(async()=>{finish({ok:[photo],rejected:[]});await sending;});
    expect(mocks.chat.sendMessageToConversation).toHaveBeenCalledExactlyOnceWith('sailing','group photo caption',undefined,undefined,[photo],{assistantScope:'universal'});
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });
});

describe('Vision recovery in the actual message action handler',()=>{
  const selected='selected synthetic text';
  const source=message('vision-source',{content:selected+' old context'});
  const refreshed={app:'openchat',conversationId:'sailing',messageId:'vision-source',sourceDigest:'b'.repeat(64)};
  function pressAlert(label:string){
    const buttons=vi.mocked(Alert.alert).mock.calls.at(-1)![2]!;
    const button=buttons.find(button=>button.text===label)!;
    button.onPress?.();
  }
  async function save(){
    await render();
    let result=true;
    await act(async()=>{result=await screen!.root.findByType('MessageActionSheet').props.onSaveToVision(source,selected);});
    return result;
  }
  it('shows review first and dispatches a new identity only after the final explicit action',async()=>{
    mocks.vision.saveToVision.mockResolvedValueOnce({status:'rejected',reason:'Source changed before dispatch',recoveryAvailable:true}).mockResolvedValueOnce({status:'saved',destinationId:'synthetic-note'});
    mocks.vision.reviewVisionSave.mockResolvedValueOnce({status:'ready',sourceRefs:[refreshed],sourceContents:[selected+' updated context']});
    expect(await save()).toBe(false);
    expect(vi.mocked(Alert.alert).mock.calls.at(-1)![0]).toBe('Save rejected before dispatch');
    expect(mocks.vision.saveToVision).toHaveBeenCalledOnce();expect(mocks.vision.reviewVisionSave).not.toHaveBeenCalled();expect(mocks.uuid).not.toHaveBeenCalled();
    await act(async()=>{pressAlert('Refresh and review');});
    expect(vi.mocked(Alert.alert).mock.calls.at(-1)!.slice(0,2)).toEqual(['Review refreshed source',expect.stringContaining(selected+' updated context')]);
    expect(mocks.vision.saveToVision).toHaveBeenCalledOnce();expect(mocks.uuid).not.toHaveBeenCalled();
    const initial=mocks.vision.saveToVision.mock.calls[0][0];
    await act(async()=>{pressAlert('Start new save attempt');});
    expect(mocks.vision.saveToVision).toHaveBeenCalledTimes(2);expect(mocks.uuid).toHaveBeenCalledOnce();
    expect(mocks.vision.saveToVision.mock.calls[1][0]).toEqual({...initial,sourceRefs:[refreshed],idempotencyKey:'openchat-attempt:synthetic-fresh-attempt',retryOf:initial.idempotencyKey});
    expect(vi.mocked(Alert.alert).mock.calls.at(-1)![0]).toBe('Saved to Vision');
  });
  it.each(['timeout','transport','unproven'])('does not offer a non-dispatch recovery for %s',async failure=>{
    if(failure==='unproven')mocks.vision.saveToVision.mockResolvedValueOnce({status:'rejected',reason:'Legacy rejection'});
    else mocks.vision.saveToVision.mockRejectedValueOnce(failure==='timeout'?new ApiError(503,'unknown',JSON.stringify({status:'uncertain',reason:'openchat-save:'+'a'.repeat(64)})):Error('connection lost'));
    await save();
    const calls=vi.mocked(Alert.alert).mock.calls;
    expect(calls.at(-1)![0]).not.toBe('Save rejected before dispatch');
    expect(mocks.vision.reviewVisionSave).not.toHaveBeenCalled();expect(mocks.uuid).not.toHaveBeenCalled();
    expect(mocks.vision.saveToVision).toHaveBeenCalledOnce();
  });
  it('retains the actual Response503 to ApiError marker and warning in the nested save catch',async()=>{
    const marker='openchat-save:'+'c'.repeat(64);
    mocks.vision.saveToVision.mockRejectedValueOnce(await errorFromResponse(new Response(JSON.stringify({status:'uncertain',reason:marker}),{status:503})));
    await save();
    const alert=vi.mocked(Alert.alert).mock.calls.at(-1)!;
    expect(alert[0]).toBe('Save outcome unknown');expect(alert[1]).toContain(marker);expect(alert[1]).toContain('duplicate');
    expect(mocks.uuid).not.toHaveBeenCalled();
  });
});

describe('community announcements composer', () => {
  it.each([false, undefined])('hides message input without explicit posting permission (%s)', async canPost => {
    mocks.chat.conversations[0] = { ...mocks.chat.conversations[0], communityKind: 'announcements', communityId: 'community-a', canPost };
    await render();
    expect(renderedText()).toContain('Only community admins can post announcements.');
    expect(screen!.root.findAllByType('TextInput')).toHaveLength(0);
    expect(screen!.root.findAllByProps({ accessibilityLabel: 'Attach image' })).toHaveLength(0);
  });
  it('keeps the normal composer for an admin and removes it when permission is revoked', async () => {
    mocks.chat.conversations[0] = { ...mocks.chat.conversations[0], communityKind: 'announcements', communityId: 'community-a', canPost: true };
    await render();
    expect(screen!.root.findAllByType('TextInput')).toHaveLength(1);
    mocks.chat.conversations = [{ ...mocks.chat.conversations[0], canPost: false }];
    await render();
    expect(screen!.root.findAllByType('TextInput')).toHaveLength(0);
    expect(renderedText()).toContain('Only community admins can post announcements.');
  });
});

it.each(['web', 'ios', 'android'])('keeps a pasted URL in the existing message composer on %s', async platform => {
  mocks.platform = platform;
  const url = 'https://example.test/policy?reference=typed#anchor';
  await render();
  await act(async () => screen!.root.findByType('TextInput').props.onChangeText(url));
  expect(screen!.root.findByType('TextInput').props.value).toBe(url);
  expect(mocks.chat.sendMessageToConversation).not.toHaveBeenCalled();
  const send = screen!.root.find(node => node.type === 'TouchableOpacity' && node.props.accessibilityLabel === 'Send message');
  await act(async () => { await send.props.onPress(); });
  expect(mocks.chat.sendMessageToConversation).toHaveBeenCalledExactlyOnceWith('sailing', url, undefined, undefined, undefined, { assistantScope: 'universal' });
});
