import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../mobile/src/services/thoughts.js';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, any>,
  recording: {} as Record<string, any>,
  navigation: { setOptions: vi.fn(), navigate: vi.fn() },
  route: { name: 'ConversationThoughts', params: { conversationId: 'conv-1', title: 'Team Chat' } },
  content: vi.fn(),
  pin: vi.fn(),
  fetchConversationThoughts: vi.fn(),
  fetchThoughts: vi.fn(),
  createThought: vi.fn(),
  getSocket: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
  })),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    Appearance: { getColorScheme: () => 'light' },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
    Alert: { alert: vi.fn() },
    Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    Text: 'Text',
    TextInput: 'TextInput',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
    ScrollView: ({ refreshControl: _refreshControl, children, ...props }: any) =>
      React.createElement('ScrollView', props, children),
    RefreshControl: () => null,
    Pressable: 'Pressable',
    Modal: ({ visible, children }: any) => (visible ? children : null),
    FlatList: React.forwardRef(({ data, renderItem, ListEmptyComponent, ListHeaderComponent }: any) =>
      React.createElement(
        'FlatList',
        null,
        ListHeaderComponent,
        data && data.length
          ? data.map((item: any, index: number) =>
              React.createElement(
                React.Fragment,
                { key: item.id ?? item.key ?? index },
                renderItem({ item, index })
              )
            )
          : ListEmptyComponent
      )
    ),
  };
});

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => mocks.navigation,
  useRoute: () => mocks.route,
  useFocusEffect: (cb: any) => {
    React.useEffect(() => {
      cb();
    }, [cb]);
  },
}));

vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => mocks.chat }));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({
  useSocialExperience: () => ({ enhanced: false }),
}));
vi.mock('../../mobile/src/contexts/RecordingContext', () => ({ useRecording: () => mocks.recording }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getConversationContent: mocks.content, pinThought: mocks.pin, createThought: mocks.createThought, getHashtagSuggestions: async () => [] } }));
vi.mock('../../mobile/src/api/socket', () => ({
  getSocket: () => mocks.getSocket(),
  joinConversation: vi.fn(),
  leaveConversation: vi.fn(),
}));
vi.mock('../../mobile/src/services/notifications', () => ({
  setActiveConversationForNotifications: vi.fn(),
}));
vi.mock('../../mobile/src/services/haptics', () => ({ hapticSend: vi.fn(), hapticReceive: vi.fn() }));
vi.mock('../../mobile/src/services/attachments', () => ({ pickImage: vi.fn(), uploadImage: vi.fn() }));
vi.mock('../../mobile/src/services/exportDownload', () => ({ saveJsonDownload: vi.fn() }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('../../mobile/src/services/hashtagSuggestions', () => ({
  fetchHashtagSuggestions: vi.fn(),
  invalidateHashtagSuggestions: vi.fn(),
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

vi.mock('../../mobile/src/services/thoughts', () => ({
  fetchConversationThoughts: (...args: any[]) => mocks.fetchConversationThoughts(...args),
  createThought: (...args: any[]) => mocks.createThought(...args),
  fetchThoughts: (...args: any[]) => mocks.fetchThoughts(...args),
  updateThought: vi.fn(),
  pinThought: vi.fn(),
  unpinThought: vi.fn(),
  deleteThought: vi.fn(),
}));

import { ContextComposer } from '../../mobile/src/components/ContextComposer';
import { ConversationThoughtsScreen } from '../../mobile/src/screens/ConversationThoughtsScreen.js';
import { ThoughtCard } from '../../mobile/src/components/ThoughtCard.js';
import { ChatScreen } from '../../mobile/src/screens/ChatScreen.js';

describe('ConversationThoughtsScreen parity & search', () => {
  let screen: ReturnType<typeof create> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.content.mockResolvedValue({ items: [] });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.route = {
      name: 'ConversationThoughts',
      params: { conversationId: 'conv-1', title: 'Team Chat' },
    };
    mocks.chat = {
      currentUser: { userId: 'alice', name: 'Alice' },
      conversations: [
        {
          id: 'conv-1',
          type: 'group',
          title: 'Team Chat',
          participants: [
            { user: { id: 'alice', name: 'Alice' }, role: 'owner' },
            { user: { id: 'bob', name: 'Bob' }, role: 'member' },
          ],
        } as Conversation,
      ],
      messages: [],
      loadingMessages: false,
      isConnected: true,
      setActiveConversation: vi.fn(),
      registerConversationVisibility: vi.fn(() => vi.fn()),
      isChatVisible: vi.fn(() => false),
      markConversationRead: vi.fn(),
      presence: new Map(),
      typingByConv: new Map(),
      readByOthers: new Map(),
      onlineUsers: new Map(),
      mutedConvs: {},
      muteConv: vi.fn(),
      reportTyping: vi.fn(),
    };
    mocks.recording = {
      status: 'idle',
      conversationId: null,
      elapsedMs: 0,
      pressStartX: { current: 0 },
    };
  });

  afterEach(async () => {
    await act(async () => {
      screen?.unmount();
    });
    screen = undefined;
    vi.useRealTimers();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const entry = (text: string) => ({ id: 'entry', origin: 'stream', visibility: 'private', provenance: 'private_note', sourceAliases: ['entry'], createdAt: '2026-10-07T00:00:00Z', thought: { id: 'entry', text, kind: 'observation', status: 'open', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', authorId: 'alice', tags: ['alpha'] } });
  const mount = async () => { await act(async () => { screen = create(React.createElement(ConversationThoughtsScreen)); }); };
  const button = (label: string) => screen!.root.findAllByType('TouchableOpacity' as any).find(node => node.props.accessibilityLabel === label || node.findAllByType('Text' as any).some(text => text.children.join('') === label))!;
  it('opens the unified read through the existing Stream door with audience labels and distinct search empty states', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Private scoped memory')] }); await mount();
    expect(mocks.content).toHaveBeenCalledWith('conv-1', expect.objectContaining({ filter: 'all' }));
    expect(JSON.stringify(screen!.toJSON())).toContain('Only you'); expect(JSON.stringify(screen!.toJSON())).toContain('Private scoped memory');
    mocks.content.mockResolvedValue({ items: [] });
    await act(async () => screen!.root.findByProps({ accessibilityLabel: 'Search conversation content' }).props.onChangeText('missing'));
    await act(async () => vi.advanceTimersByTime(300));
    expect(JSON.stringify(screen!.toJSON())).toContain('No matching conversation content.');
    await act(async () => button('Clear search').props.onPress()); await act(async () => vi.advanceTimersByTime(1));
    expect(JSON.stringify(screen!.toJSON())).toContain('Private entries are labeled Only you.');
  });
  it('filters tagged entries through the unified server query and refreshes after Stream events', async () => {
    const listeners: Record<string, () => void> = {}; mocks.getSocket.mockReturnValue({ on: vi.fn((name, fn) => { listeners[name] = fn; }), off: vi.fn() });
    mocks.content.mockResolvedValue({ items: [entry('Tagged entry')] }); await mount();
    await act(async () => screen!.root.findByType(ThoughtCard).props.onTagPress('alpha')); await act(async () => vi.advanceTimersByTime(300));
    expect(mocks.content).toHaveBeenLastCalledWith('conv-1', expect.objectContaining({ search: 'alpha' }));
    mocks.content.mockResolvedValue({ items: [entry('Refreshed shared source')] }); await act(async () => listeners['thought:updated']());
    expect(JSON.stringify(screen!.toJSON())).toContain('Refreshed shared source');
  });
  it('creates only private scoped entries from the private entry action', async () => {
    mocks.createThought.mockResolvedValue(entry('Saved').thought); await mount();
    await act(async () => button('Private entry').props.onPress());
    const input = screen!.root.findAllByType('TextInput' as any).find(node => node.props.accessibilityLabel === 'Stream entry text')!;
    await act(async () => input.props.onChangeText('Saved'));
    await act(async () => button('Save entry').props.onPress());
    expect(mocks.createThought).toHaveBeenCalledWith({ text: 'Saved', scopeConversationId: 'conv-1' });
  });

  it('keeps private Stream creation and search usable with Context disabled and hides Context controls', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Private memory with Context off')], contextAvailable: false });
    mocks.createThought.mockResolvedValue(entry('Saved privately').thought); await mount();
    expect(JSON.stringify(screen!.toJSON())).toContain('Private memory with Context off');
    expect(button('Context posts')).toBeUndefined();
    expect(screen!.root.findAllByType(ContextComposer)).toHaveLength(0);
    expect(screen!.root.findAllByProps({ accessibilityLabel: 'Search conversation content' })[0].props.placeholder).toBe('Search Stream');
    await act(async () => button('Private entry').props.onPress());
    await act(async () => screen!.root.findAllByType('TextInput' as any).find(node => node.props.accessibilityLabel === 'Stream entry text')!.props.onChangeText('Saved privately'));
    await act(async () => button('Save entry').props.onPress());
    expect(mocks.createThought).toHaveBeenCalledWith({ text: 'Saved privately', scopeConversationId: 'conv-1' });
  });

  it('requires an exact private-entry sharing preview before pinning into the shared chat', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Private source to share')] }); mocks.pin.mockResolvedValue({}); await mount();
    await act(async () => button('Share & pin…').props.onPress());
    expect(mocks.pin).not.toHaveBeenCalled(); expect(JSON.stringify(screen!.toJSON())).toContain('Current and future authorized members');
    await act(async () => button('Share & pin to this chat').props.onPress()); expect(mocks.pin).toHaveBeenCalledWith('entry', 'conv-1', 'Private source to share');
  });
  it('a changed private entry cannot be shared using a previous on-screen preview', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Reviewed private text')] }); await mount();
    await act(async () => button('Share & pin…').props.onPress());
    mocks.content.mockResolvedValue({ items: [entry('Changed private text')] }); await act(async () => button('Refresh').props.onPress());
    expect(button('Share & pin to this chat').props.disabled).toBe(true); expect(mocks.pin).not.toHaveBeenCalled();
    expect(JSON.stringify(screen!.toJSON())).toContain('Entry changed. Cancel and review');
  });
  it('reselecting the current content filter keeps loaded entries visible', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Still visible')] }); await mount();
    await act(async () => button('All content').props.onPress()); expect(JSON.stringify(screen!.toJSON())).toContain('Still visible');
  });
  it('switching account synchronously removes private rows and ignores the old pending read', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Alice private')] }); await mount();
    let complete!: (value: any) => void; mocks.content.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await act(async () => button('Refresh').props.onPress());
    mocks.chat.currentUser = { userId: 'bob', name: 'Bob' }; mocks.content.mockResolvedValue({ items: [] });
    await act(async () => screen!.update(React.createElement(ConversationThoughtsScreen)));
    expect(JSON.stringify(screen!.toJSON())).not.toContain('Alice private');
    await act(async () => complete({ items: [entry('Late Alice private')] })); expect(JSON.stringify(screen!.toJSON())).not.toContain('Late Alice private');
  });
  it('permission loss removes private rows instead of retaining cached content', async () => {
    mocks.content.mockResolvedValue({ items: [entry('Alice private')] }); await mount();
    mocks.content.mockRejectedValue(Object.assign(new Error('Access removed'), { status: 403 }));
    await act(async () => button('Refresh').props.onPress()); expect(JSON.stringify(screen!.toJSON())).not.toContain('Alice private'); expect(JSON.stringify(screen!.toJSON())).toContain('Access removed');
  });

  it('ChatScreen renders a visible Stream button satisfying the Front-Door Test', async () => {
    let chatScreen: ReturnType<typeof create> | undefined;
    mocks.route = {
      name: 'Chat' as any,
      params: { conversationId: 'conv-1' } as any,
    };

    await act(async () => {
      chatScreen = create(React.createElement(ChatScreen, { conversationId: 'conv-1' }));
    });

    // Check headerRight was set on navigation
    expect(mocks.navigation.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        headerRight: expect.any(Function),
      })
    );

    const headerRightFn = mocks.navigation.setOptions.mock.calls[0][0].headerRight;
    const headerElement = headerRightFn();
    let renderedHeader: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderedHeader = create(headerElement);
    });

    // Verify the visible word "Thoughts" exists in the button
    const thoughtsBtn = renderedHeader!.root.findByProps({ accessibilityLabel: 'Stream for this chat' });
    expect(thoughtsBtn).toBeDefined();

    const labelText = thoughtsBtn.findByProps({ children: 'Stream' });
    expect(labelText).toBeDefined();

    // Verify tapping the button navigates to ConversationThoughts
    await act(async () => {
      thoughtsBtn.props.onPress();
    });

    expect(mocks.navigation.navigate).toHaveBeenCalledWith('ConversationThoughts', {
      conversationId: 'conv-1',
      title: 'Team Chat',
    });

    await act(async () => {
      renderedHeader?.unmount();
      chatScreen?.unmount();
    });
  });
});
