import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Thought } from '../../mobile/src/services/thoughts.js';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, any>,
  recording: {} as Record<string, any>,
  navigation: { setOptions: vi.fn(), navigate: vi.fn() },
  route: { name: 'ConversationThoughts', params: { conversationId: 'conv-1', title: 'Team Chat' } },
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
    ScrollView: ({ refreshControl, children, ...props }: any) =>
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
vi.mock('../../mobile/src/api/client', () => ({ api: {} }));
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

import { ConversationThoughtsScreen } from '../../mobile/src/screens/ConversationThoughtsScreen.js';
import { ThoughtsScreen } from '../../mobile/src/screens/ThoughtsScreen.js';
import { StreamEditor } from '../../mobile/src/components/StreamEditor.js';
import { ThoughtsSearchBar } from '../../mobile/src/components/ThoughtsSearchBar.js';
import { ChatScreen } from '../../mobile/src/screens/ChatScreen.js';

describe('ConversationThoughtsScreen parity & search', () => {
  let screen: ReturnType<typeof create> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
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

  it('renders distinct empty states when no thoughts exist yet vs no search results', async () => {
    mocks.fetchConversationThoughts.mockResolvedValue({
      pinned: [],
      fromChat: [],
    });

    await act(async () => {
      screen = create(React.createElement(ConversationThoughtsScreen));
    });

    // When empty without search: shows default explanation for both sections
    const initialText = JSON.stringify(screen!.toJSON());
    expect(initialText).toContain('Nothing pinned yet');
    expect(initialText).toContain('Shared tags from this chat land here');
    expect(initialText).not.toContain('No Stream entries match');

    // Enter a search query
    const searchInput = screen!.root.findByProps({ placeholder: "Search or create in this chat's Stream" });
    await act(async () => {
      searchInput.props.onChangeText('unmatched query');
    });

    // Advance debounce timer (250ms)
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mocks.fetchConversationThoughts).toHaveBeenCalledWith('conv-1', { q: 'unmatched query' });

    // Under active search with 0 results: shows distinct "No Stream entries match" empty state with Clear search
    const searchingText = JSON.stringify(screen!.toJSON());
    expect(searchingText).toContain('No Stream entries match');
    expect(searchingText).toContain('unmatched query');
    expect(searchingText).toContain('Clear search');
  });

  it('searches in a chat’s thoughts and restoring search restores the full list', async () => {
    const fullThoughts = {
      pinned: [
        {
          id: 'p1',
          text: 'Project roadmap note',
          kind: 'fact',
          status: 'none',
          createdAt: '2026-09-20T10:00:00Z',
          tags: ['roadmap'],
          pinned: true,
          authorId: 'alice',
        } as Thought,
      ],
      fromChat: [
        {
          id: 'c1',
          text: 'Team budget #finance',
          kind: 'fact',
          status: 'none',
          createdAt: '2026-09-21T10:00:00Z',
          tags: ['finance'],
          pinned: false,
          authorId: 'bob',
        } as Thought,
      ],
    };

    const searchResults = {
      pinned: [
        {
          id: 'p1',
          text: 'Project roadmap note',
          kind: 'fact',
          status: 'none',
          createdAt: '2026-09-20T10:00:00Z',
          tags: ['roadmap'],
          pinned: true,
          authorId: 'alice',
        } as Thought,
      ],
      fromChat: [],
    };

    mocks.fetchConversationThoughts.mockResolvedValueOnce(fullThoughts);

    await act(async () => {
      screen = create(React.createElement(ConversationThoughtsScreen));
    });

    expect(JSON.stringify(screen!.toJSON())).toContain('Project roadmap note');
    expect(JSON.stringify(screen!.toJSON())).toContain('Team budget #finance');

    // Perform search
    mocks.fetchConversationThoughts.mockResolvedValueOnce(searchResults);
    const searchInput = screen!.root.findByProps({ placeholder: "Search or create in this chat's Stream" });
    await act(async () => {
      searchInput.props.onChangeText('roadmap');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mocks.fetchConversationThoughts).toHaveBeenCalledWith('conv-1', { q: 'roadmap' });
    expect(JSON.stringify(screen!.toJSON())).toContain('Project roadmap note');
    expect(JSON.stringify(screen!.toJSON())).not.toContain('Team budget #finance');

    // Clear search using the clear button
    mocks.fetchConversationThoughts.mockResolvedValueOnce(fullThoughts);
    const clearButton = screen!.root.findByProps({ accessibilityLabel: 'Clear search' });
    await act(async () => {
      clearButton.props.onPress();
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Restores full list without q
    expect(mocks.fetchConversationThoughts).toHaveBeenLastCalledWith('conv-1', undefined);
    expect(JSON.stringify(screen!.toJSON())).toContain('Project roadmap note');
    expect(JSON.stringify(screen!.toJSON())).toContain('Team budget #finance');
  });

  it.each([['global', ThoughtsScreen], ['chat', ConversationThoughtsScreen]] as const)('preserves a new draft while %s creation is pending', async (_scope, Screen) => {
    mocks.fetchThoughts.mockResolvedValue([]);
    mocks.fetchConversationThoughts.mockResolvedValue({ pinned: [], fromChat: [] });
    let resolve!: (thought: Thought) => void;
    mocks.createThought.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await act(async () => { screen = create(React.createElement(Screen)); });
    await act(async () => screen!.root.findByType(ThoughtsSearchBar).props.onCreate('A'));
    await act(async () => { screen!.root.findByType(StreamEditor).props.onSave(); });
    expect(mocks.createThought).toHaveBeenCalledWith(_scope === 'global' ? { text: 'A' } : { text: 'A', scopeConversationId: 'conv-1' });
    await act(async () => screen!.root.findByType(StreamEditor).props.onChangeText('B'));
    await act(async () => resolve({ id: 'saved-a', text: 'A', tags: [], createdAt: '2026-10-05T00:00:00Z', kind: 'observation', status: 'none' } as Thought));
    expect(screen!.root.findByType(StreamEditor).props.value).toBe('B');
  });

  it('updates search query when a tag chip is pressed', async () => {
    const thoughtsWithTag = {
      pinned: [
        {
          id: 'p1',
          text: 'Project roadmap note #strategy',
          kind: 'fact',
          status: 'none',
          createdAt: '2026-09-20T10:00:00Z',
          tags: ['strategy'],
          pinned: true,
          authorId: 'alice',
        } as Thought,
      ],
      fromChat: [],
    };

    mocks.fetchConversationThoughts.mockResolvedValueOnce(thoughtsWithTag);

    await act(async () => {
      screen = create(React.createElement(ConversationThoughtsScreen));
    });

    // Find the tag chip TouchableOpacity (innermost TouchableOpacity containing the tag text)
    const matchingTouchables = screen!.root
      .findAllByType('TouchableOpacity')
      .filter((node) =>
        node.findAllByType('Text').some((t) => {
          const c = t.props.children;
          return Array.isArray(c) ? c.includes('strategy') : c === '#strategy' || c === 'strategy';
        })
      );
    const tagChip = matchingTouchables[matchingTouchables.length - 1];
    expect(tagChip).toBeDefined();

    // Tap tag chip
    mocks.fetchConversationThoughts.mockResolvedValueOnce(thoughtsWithTag);
    await act(async () => {
      tagChip.props.onPress();
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Verifies search query was updated to the tag without #
    expect(mocks.fetchConversationThoughts).toHaveBeenCalledWith('conv-1', { q: 'strategy' });
  });

  it('live socket updates update thoughts live', async () => {
    let socketHandlers: Record<string, Function> = {};
    mocks.getSocket.mockReturnValue({
      on: (event: string, handler: Function) => {
        socketHandlers[event] = handler;
      },
      off: (event: string) => {
        delete socketHandlers[event];
      },
    });

    mocks.fetchConversationThoughts.mockResolvedValueOnce({
      pinned: [],
      fromChat: [],
    });

    await act(async () => {
      screen = create(React.createElement(ConversationThoughtsScreen));
    });

    expect(JSON.stringify(screen!.toJSON())).not.toContain('Live incoming thought');

    // Simulate thought:created event for this conversation
    await act(async () => {
      socketHandlers['thought:created']?.({
        thought: {
          id: 'new-1',
          text: 'Live incoming thought',
          kind: 'fact',
          status: 'none',
          createdAt: '2026-09-22T10:00:00Z',
          tags: [],
          sourceConversationId: 'conv-1',
          pinned: false,
          authorId: 'alice',
        },
      });
    });

    expect(JSON.stringify(screen!.toJSON())).toContain('Live incoming thought');
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
