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
  rowRenders: 0,
  scheme: 'light' as 'light' | 'dark',
  ticks: 0,
}));

// Counts message-row renders through the real ChatScreen, with FlatList cells
// memoized the way VirtualizedList memoizes them. Typing in the composer, a
// typing indicator or the keyboard opening must not re-render every message
// row: on a long thread that is what makes typing and scrolling stutter.
vi.mock('react-native', async () => {
  const React = await import('react');
  const Cell = React.memo(({ item, index, renderItem }: any) => renderItem({ item, index }));
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
    useWindowDimensions: () => ({ width: 390, height: 844 }),
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
    // Mirrors VirtualizedList: each cell is a PureComponent keyed by item, so
    // a cell re-renders only when its item, renderItem or extraData changes.
    FlatList: React.forwardRef(({ data, renderItem, extraData, ListEmptyComponent, ListHeaderComponent }: any, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: mocks.scroll, scrollToIndex: vi.fn() }));
      return React.createElement('FlatList', null, ListHeaderComponent,
        data.length ? data.map((item: any, index: number) => React.createElement(
          Cell, { key: item.key, item, index, renderItem, extraData },
        )) : ListEmptyComponent);
    }),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }) }));
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (fn: any) => React.useEffect(() => mocks.focused ? fn() : undefined, [fn, mocks.focused]),
  useNavigation: () => mocks.navigation,
  useNavigationState: (select: (state: { index: number }) => number) => select({ index: 1 }), useRoute: () => mocks.route,
}));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: mocks.scheme }) }));
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
vi.mock('../../mobile/src/components/MessageText', () => ({
  MessageText: ({ content }: { content: string }) => { mocks.rowRenders++; return React.createElement('Text', null, content); },
}));
vi.mock('../../mobile/src/components/ExportSheet', () => ({ ExportSheet: () => null }));

import { ChatScreen } from '../../mobile/src/screens/ChatScreen.js';

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id, content: `Message ${id}`, conversationId: 'sailing', senderId: id.endsWith('b') ? 'bob' : 'alice',
    sender: id.endsWith('b') ? { id: 'bob', name: 'Bob' } : { id: 'alice', name: 'Alice' },
    createdAt: `2026-09-21T00:${id.padStart(2, '0').slice(0, 2)}:00Z`, ...overrides,
  };
}

let screen: ReturnType<typeof create> | undefined;
async function render() {
  await act(async () => {
    const element = React.createElement(ChatScreen, { conversationId: 'sailing' });
    if (screen) screen.update(element);
    else screen = create(element);
  });
}
async function rendersDuring(change: () => void | Promise<void>) {
  mocks.rowRenders = 0;
  await act(async () => { await change(); });
  return mocks.rowRenders;
}

const MESSAGES = Array.from({ length: 40 }, (_, i) => message(`${10 + i}${i % 3 ? '' : 'b'}`));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.platform = 'ios';
  mocks.scheme = 'light';
  mocks.focused = true;
  mocks.inputFocused = false;
  mocks.keyboardEvents.clear();
  mocks.appStateEvents.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.chat = {
    currentUser: { userId: 'bob', name: 'Bob' },
    conversations: [{ id: 'sailing', type: 'group', title: 'Sailing Buddies', participants: [
      { user: { id: 'alice', name: 'Alice' }, role: 'owner' },
      { user: { id: 'bob', name: 'Bob' }, role: 'member' },
    ] } satisfies Conversation],
    messages: MESSAGES, loadingMessages: false, isConnected: true,
    activeConversationId: 'sailing', activeConversationLane: 'chat',
    isChatVisible: () => true,
    registerConversationVisibility: vi.fn(() => vi.fn()),
    setActiveConversation: vi.fn(), markConversationRead: vi.fn(), sendMessageToConversation: vi.fn(async () => {}),
    presence: new Map(), typingByConv: new Map(), readByOthers: new Map(), onlineUsers: new Map(),
    mutedConvs: {}, muteConv: vi.fn(), reportTyping: vi.fn(),
  };
  mocks.recording = { status: 'idle', conversationId: null, elapsedMs: 0, pressStartX: { current: 0 } };
});
afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  vi.useRealTimers();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('chat row render budget', () => {
  it('renders every message once on open', async () => {
    mocks.rowRenders = 0;
    await render();
    expect(mocks.rowRenders).toBeGreaterThanOrEqual(MESSAGES.length);
  });

  it('does not re-render message rows while typing in the composer', async () => {
    await render();
    const input = () => screen!.root.findByType('TextInput');
    const counts = [];
    for (const draft of ['H', 'He', 'Hel', 'Hell', 'Hello']) counts.push(await rendersDuring(() => input().props.onChangeText(draft)));
    expect(counts).toEqual([0, 0, 0, 0, 0]);
  });

  it('does not re-render message rows when the keyboard opens', async () => {
    await render();
    mocks.inputFocused = true;
    expect(await rendersDuring(() => {
      mocks.keyboardEvents.get('keyboardWillShow')?.();
      mocks.keyboardEvents.get('keyboardDidShow')?.();
    })).toBe(0);
  });

  it('does not re-render message rows when someone starts typing', async () => {
    await render();
    mocks.chat = { ...mocks.chat, typingByConv: new Map([['sailing', new Set(['alice'])]]) };
    expect(await rendersDuring(render)).toBe(0);
    expect(JSON.stringify(screen!.toJSON())).toContain('Alice is typing');
  });

  it('re-renders only when a row actually changes', async () => {
    await render();
    const edited = MESSAGES.map((m, i) => i === 5 ? { ...m, content: 'Edited text' } : m);
    mocks.chat = { ...mocks.chat, messages: edited };
    const count = await rendersDuring(render);
    expect(JSON.stringify(screen!.toJSON())).toContain('Edited text');
    expect(count).toBe(1);
  });

  it('renders only the new row and the previous run end when a message arrives', async () => {
    await render();
    const incoming = message('99', { createdAt: MESSAGES[MESSAGES.length - 1].createdAt });
    mocks.chat = { ...mocks.chat, messages: [...MESSAGES, incoming] };
    const count = await rendersDuring(render);
    expect(JSON.stringify(screen!.toJSON())).toContain('Message 99');
    expect(count).toBeLessThanOrEqual(2);
  });

  it('keeps a direct chat quiet while typing', async () => {
    mocks.chat = { ...mocks.chat, conversations: [{ id: 'sailing', type: 'direct', participants: [
      { user: { id: 'alice', name: 'Alice' } }, { user: { id: 'bob', name: 'Bob' } },
    ] } as Conversation] };
    await render();
    expect(await rendersDuring(() => screen!.root.findByType('TextInput').props.onChangeText('Hi'))).toBe(0);
    mocks.chat = { ...mocks.chat, typingByConv: new Map([['sailing', new Set(['alice'])]]) };
    expect(await rendersDuring(render)).toBe(0);
  });

  it('re-renders rows for a theme change', async () => {
    await render();
    mocks.scheme = 'dark';
    expect(await rendersDuring(render)).toBeGreaterThanOrEqual(MESSAGES.length);
  });

  it('re-renders rows when the other person reads the thread', async () => {
    mocks.chat = { ...mocks.chat, conversations: [{ id: 'sailing', type: 'direct', participants: [
      { user: { id: 'alice', name: 'Alice' } }, { user: { id: 'bob', name: 'Bob' } },
    ] } as Conversation] };
    await render();
    const readTicks = () => JSON.stringify(screen!.toJSON()).match(/"✓✓"/g)?.length ?? 0;
    const before = readTicks();
    mocks.chat = { ...mocks.chat, readByOthers: new Map([['sailing', new Map([['alice', '2026-12-31T00:00:00Z']])]]) };
    expect(await rendersDuring(render)).toBeGreaterThanOrEqual(MESSAGES.length);
    expect(before).toBe(0);
    expect(readTicks()).toBeGreaterThan(0);
  });

  it('re-renders a row when its reactions change', async () => {
    await render();
    const reacted = MESSAGES.map((m, i) => i === 3 ? { ...m, content: 'Reacted text', reactions: [{ emoji: '👍', count: 1, byMe: true }] } : m);
    mocks.chat = { ...mocks.chat, messages: reacted };
    expect(await rendersDuring(render)).toBe(1);
    expect(JSON.stringify(screen!.toJSON())).toContain('Reacted text');
  });

  it('still re-renders rows when their inputs change', async () => {
    await render();
    mocks.chat = { ...mocks.chat, activeConversationLane: 'chat', activeConversationId: 'other' };
    expect(await rendersDuring(render)).toBeGreaterThanOrEqual(MESSAGES.length);
  });
});
