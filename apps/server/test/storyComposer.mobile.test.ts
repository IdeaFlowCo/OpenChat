import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, IntentDraft, OwnedStory } from '../../mobile/src/api/client.js';

const mocks = vi.hoisted(() => ({
  navigation: { goBack: vi.fn(), navigate: vi.fn() },
  route: { params: {} as Record<string, any> },
  api: {
    listIntentDrafts: vi.fn(),
    createIntentDraft: vi.fn(),
    activateIntentDraft: vi.fn(),
    createStory: vi.fn(),
    listMyStories: vi.fn(),
    updateStory: vi.fn(),
    updateIntentDraft: vi.fn(),
  },
  chat: {
    currentUser: { userId: 'alice', name: 'Alice' },
    conversations: [
      {
        id: 'conv-bob',
        type: 'direct',
        title: 'Bob',
        participants: [
          { user: { id: 'alice', name: 'Alice' }, role: 'member' },
          { user: { id: 'bob', name: 'Bob' }, role: 'member' },
        ],
      } satisfies Conversation,
    ],
  },
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ActivityIndicator: 'ActivityIndicator',
    KeyboardAvoidingView: ({ children }: any) => React.createElement('KeyboardAvoidingView', null, children),
    ScrollView: ({ children }: any) => React.createElement('ScrollView', null, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
    TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    FlatList: ({ data, renderItem, ListEmptyComponent }: any) => React.createElement(
      'FlatList',
      null,
      data && data.length ? data.map((item: any, index: number) => React.createElement(
        React.Fragment,
        { key: item.key ?? index },
        renderItem({ item, index }),
      )) : ListEmptyComponent,
    ),
  };
});

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => mocks.navigation,
  useRoute: () => mocks.route,
  useFocusEffect: (cb: () => void) => {
    React.useEffect(() => { cb(); }, [cb]);
  },
}));

vi.mock('../../mobile/src/contexts/ThemeContext', () => ({
  useTheme: () => ({ scheme: 'light' }),
}));

vi.mock('../../mobile/src/contexts/ChatContext', () => ({
  useChat: () => mocks.chat,
}));

vi.mock('../../mobile/src/api/client', () => ({
  api: mocks.api,
}));

vi.mock('../../mobile/src/components/AppIcon', () => ({
  AppIcon: () => null,
}));

import { StoryComposerScreen, DESTINATION_OPTIONS } from '../../mobile/src/screens/StoryComposerScreen.js';
import { AsksScreen } from '../../mobile/src/screens/AsksScreen.js';

let root: ReturnType<typeof create> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.route.params = {};
  mocks.api.listIntentDrafts.mockResolvedValue([]);
  mocks.api.listMyStories.mockResolvedValue([]);
  mocks.api.createIntentDraft.mockResolvedValue({ draft: { id: 'draft-new' } });
  mocks.api.activateIntentDraft.mockResolvedValue({ draft: { id: 'draft-1' } });
  mocks.api.createStory.mockResolvedValue({ story: { id: 'story-new' } });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

function findByText(text: string): ReactTestInstance | undefined {
  if (!root) return undefined;
  return root.root.findAll((node) => {
    if (node.type === 'Text') {
      const children = Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children ?? '');
      return children.includes(text);
    }
    return false;
  })[0];
}

function findTouchableWithText(text: string): ReactTestInstance | undefined {
  if (!root) return undefined;
  return root.root.findAll((node) => {
    if (node.type === 'TouchableOpacity') {
      const textNodes = node.findAllByType('Text');
      const combined = textNodes.map((n) => Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')).join(' ');
      return combined.includes(text);
    }
    return false;
  })[0];
}

describe('StoryComposerScreen audience destination control', () => {
  it('displays the three destinations with plain explanatory sentences and visible words', async () => {
    await act(async () => {
      root = create(React.createElement(StoryComposerScreen));
    });

    for (const option of DESTINATION_OPTIONS) {
      expect(findByText(option.label)).toBeDefined();
      expect(findByText(option.sentence)).toBeDefined();
    }

    expect(findByText('Only agents in the selected chats can search this; it never appears in anyone’s Stories feed.')).toBeDefined();
    expect(findByText('Posts to the selected chats’ Stories feed and lets their agents search quietly for matches.')).toBeDefined();
    expect(findByText('Posts a visible Story to the selected chats’ Stories feed; no background agent search is run.')).toBeDefined();
  });

  it('composing with agents-only selected sends quietSearch.enabled = true and story.enabled = false', async () => {
    await act(async () => {
      root = create(React.createElement(StoryComposerScreen));
    });

    // Enter ask text
    const textInput = root!.root.findByProps({ accessibilityLabel: 'Story text' });
    await act(async () => {
      textInput.props.onChangeText('Looking for a ticket to the concert');
    });

    // Select Agents only
    const agentsOnlyOption = findTouchableWithText('Agents only');
    expect(agentsOnlyOption).toBeDefined();
    await act(async () => {
      agentsOnlyOption!.props.onPress();
    });

    // Select audience conversation (Bob)
    const audienceBob = findTouchableWithText('Bob');
    expect(audienceBob).toBeDefined();
    await act(async () => {
      audienceBob!.props.onPress();
    });

    // Select quiet search direction (Looking for)
    const askDirection = findTouchableWithText('I’m looking for this');
    expect(askDirection).toBeDefined();
    await act(async () => {
      askDirection!.props.onPress();
    });

    // Tap review
    const reviewBtn = findTouchableWithText('Review agent-only ask');
    expect(reviewBtn).toBeDefined();
    await act(async () => {
      reviewBtn!.props.onPress();
    });

    // Verify preview
    expect(findByText('Agents only')).toBeDefined();
    expect(findByText('This ask goes to agents only and will never appear in anyone’s Stories feed.')).toBeDefined();

    // Tap approve and publish
    const approveBtn = findTouchableWithText('Approve and search quietly');
    expect(approveBtn).toBeDefined();
    await act(async () => {
      await approveBtn!.props.onPress();
    });

    // Verify API calls
    expect(mocks.api.createIntentDraft).toHaveBeenCalledWith(expect.objectContaining({
      seeks: ['Looking for a ticket to the concert'],
      matchingMode: 'fulfillment',
    }));
    expect(mocks.api.activateIntentDraft).toHaveBeenCalledWith('draft-new', {
      confirm: true,
      quietSearch: {
        enabled: true,
        expiresAt: expect.any(String),
        audience: { userIds: [], conversationIds: ['conv-bob'] },
      },
      story: { enabled: false },
    });
    expect(mocks.api.createStory).not.toHaveBeenCalled();
    expect(mocks.navigation.goBack).toHaveBeenCalled();
  });

  it('composing from an existing draft with agents-only sends quietSearch.enabled = true and story.enabled = false', async () => {
    mocks.route.params = { draftId: 'draft-existing' };
    const existingDraft: IntentDraft = {
      id: 'draft-existing',
      ownerUserId: 'alice',
      goal: 'Find a cofounder',
      seeks: ['Technical cofounder'],
      brings: ['Product strategy'],
      matchingMode: 'reciprocal',
      openToCollaborators: false,
      details: null,
      source: null,
      confidence: 0.9,
      state: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mocks.api.listIntentDrafts.mockResolvedValue([existingDraft]);

    await act(async () => {
      root = create(React.createElement(StoryComposerScreen));
    });

    // Select Agents only
    const agentsOnlyOption = findTouchableWithText('Agents only');
    expect(agentsOnlyOption).toBeDefined();
    await act(async () => {
      agentsOnlyOption!.props.onPress();
    });

    // Select audience
    const audienceBob = findTouchableWithText('Bob');
    await act(async () => {
      audienceBob!.props.onPress();
    });

    // Review and approve
    const reviewBtn = findTouchableWithText('Review agent-only ask');
    await act(async () => {
      reviewBtn!.props.onPress();
    });

    const approveBtn = findTouchableWithText('Approve and search quietly');
    await act(async () => {
      await approveBtn!.props.onPress();
    });

    expect(mocks.api.createIntentDraft).not.toHaveBeenCalled();
    expect(mocks.api.activateIntentDraft).toHaveBeenCalledWith('draft-existing', {
      confirm: true,
      quietSearch: {
        enabled: true,
        expiresAt: expect.any(String),
        audience: { userIds: [], conversationIds: ['conv-bob'] },
      },
      story: { enabled: false },
    });
    expect(mocks.api.createStory).not.toHaveBeenCalled();
  });

  it('composing with the Stories option sends a story', async () => {
    await act(async () => {
      root = create(React.createElement(StoryComposerScreen));
    });

    const textInput = root!.root.findByProps({ accessibilityLabel: 'Story text' });
    await act(async () => {
      textInput.props.onChangeText('Here is my story text');
    });

    const audienceBob = findTouchableWithText('Bob');
    await act(async () => {
      audienceBob!.props.onPress();
    });

    const reviewBtn = findTouchableWithText('Review exact Story');
    await act(async () => {
      reviewBtn!.props.onPress();
    });

    const approveBtn = findTouchableWithText('Approve and share');
    await act(async () => {
      await approveBtn!.props.onPress();
    });

    expect(mocks.api.createStory).toHaveBeenCalledWith(expect.objectContaining({
      confirm: true,
      text: 'Here is my story text',
      audience: { userIds: [], conversationIds: ['conv-bob'] },
      storyExpiresAt: expect.any(String),
      quietSearch: undefined,
    }));
    expect(mocks.api.activateIntentDraft).not.toHaveBeenCalled();
  });

  it('refuses the both-disabled combination locally without calling the server', async () => {
    // If destination has both channels disabled (e.g. invalid destination passed via route or state)
    mocks.route.params = { destination: 'none' as any };

    await act(async () => {
      root = create(React.createElement(StoryComposerScreen));
    });

    const textInput = root!.root.findByProps({ accessibilityLabel: 'Story text' });
    await act(async () => {
      textInput.props.onChangeText('Test content');
    });

    const audienceBob = findTouchableWithText('Bob');
    await act(async () => {
      audienceBob!.props.onPress();
    });

    const reviewBtn = findTouchableWithText('Review exact Story');
    expect(reviewBtn).toBeDefined();

    await act(async () => {
      reviewBtn!.props.onPress();
    });

    expect(findByText('Choose where to share: Agents only, Stories, or both.')).toBeDefined();
    expect(mocks.api.createStory).not.toHaveBeenCalled();
    expect(mocks.api.activateIntentDraft).not.toHaveBeenCalled();

    // Now select a valid destination and verify review succeeds
    const agentsOnlyOption = findTouchableWithText('Agents only');
    await act(async () => {
      agentsOnlyOption!.props.onPress();
    });

    const askDirection = findTouchableWithText('I’m looking for this');
    await act(async () => {
      askDirection!.props.onPress();
    });

    const reviewAgentBtn = findTouchableWithText('Review agent-only ask');
    await act(async () => {
      reviewAgentBtn!.props.onPress();
    });

    expect(findByText('Agents only')).toBeDefined();
  });
});

describe('AsksScreen after-the-fact visibility', () => {
  it('clearly displays AGENTS ONLY for quiet search and Stories and agents / Stories only for stories', async () => {
    const ownedQuiet: OwnedStory = {
      id: 'story-quiet',
      ownerUserId: 'alice',
      goal: 'Find a violin teacher',
      seeks: ['Violin lessons'],
      brings: [],
      matchingMode: 'fulfillment',
      openToCollaborators: false,
      text: null,
      humanVisible: false,
      agentSearchEnabled: true,
      explicitQuietSearch: true,
      status: 'active',
      audience: { userIds: [], conversationIds: ['conv-bob'] },
      storyExpiresAt: null,
      searchExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ownedBoth: OwnedStory = {
      id: 'story-both',
      ownerUserId: 'alice',
      goal: null,
      seeks: [],
      brings: [],
      matchingMode: 'fulfillment',
      openToCollaborators: false,
      text: 'Have extra camping gear',
      humanVisible: true,
      agentSearchEnabled: true,
      explicitQuietSearch: true,
      status: 'active',
      audience: { userIds: [], conversationIds: ['conv-bob'] },
      storyExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      searchExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ownedStoryOnly: OwnedStory = {
      id: 'story-only',
      ownerUserId: 'alice',
      goal: null,
      seeks: [],
      brings: [],
      matchingMode: 'fulfillment',
      openToCollaborators: false,
      text: 'Coffee meetup tomorrow',
      humanVisible: true,
      agentSearchEnabled: false,
      explicitQuietSearch: false,
      status: 'active',
      audience: { userIds: [], conversationIds: ['conv-bob'] },
      storyExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      searchExpiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mocks.api.listMyStories.mockResolvedValue([ownedQuiet, ownedBoth, ownedStoryOnly]);

    await act(async () => {
      root = create(React.createElement(AsksScreen));
    });

    // Check AGENTS ONLY badge on quiet item
    expect(findByText('AGENTS ONLY · ACTIVE')).toBeDefined();
    expect(findByText('1 selected chat · Visible to agents only; no human Story was posted.')).toBeDefined();

    // Check STORY badges
    expect(findByText('STORY · ACTIVE')).toBeDefined();
    expect(findByText('1 selected chat · Stories and agents')).toBeDefined();
    expect(findByText('1 selected chat · Stories only')).toBeDefined();
  });
});
