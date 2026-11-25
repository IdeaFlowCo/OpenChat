/** The chat Stream's shared card header and audience labels. Synthetic fixtures only. */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({ platform: 'ios', open: vi.fn(), content: vi.fn(), collapsed: false }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return os.platform; }, select: (values: any) => values[os.platform] ?? values.default },
  Alert: { alert: vi.fn() }, Linking: { openURL: os.open },
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Modal: () => null, Pressable: 'Pressable', View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  FlatList: ({ data, renderItem }: any) => React.createElement('List', {}, data.map((item: any) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item })))),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: (fn: any) => React.useEffect(fn, [fn]), useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/components/ContextComposer', () => ({ ContextComposer: () => null }));
vi.mock('../../mobile/src/components/ContextIntentionControls', () => ({ ContextIntentionControls: () => null }));
vi.mock('../../mobile/src/components/StreamCompactToggle', () => ({ StreamCompactToggle: () => null }));
vi.mock('../../mobile/src/components/StreamEditor', () => ({ StreamTextInput: 'TextInput' }));
vi.mock('../../mobile/src/api/socket', () => ({ getSocket: () => null }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'alice' } }) }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('../../mobile/src/services/streamDisplay', () => ({
  COMPACT_VISIBLE_LINES: 4, isLongStreamText: () => false, applyCollapsed: vi.fn(), ingestStreamCollapsed: vi.fn(),
  useStreamCompact: () => [false, vi.fn()], useThoughtCollapsed: () => [os.collapsed, vi.fn(async () => undefined)],
}));
vi.mock('../../mobile/src/api/client', () => ({ api: { getConversationContent: os.content } }));
import { ContextLane } from '../../mobile/src/components/ContextLane';
import { ConversationLaneSwitch } from '../../mobile/src/components/ConversationLaneSwitch';


const when = '2026-11-20T00:00:00Z';
const post = (id: string, kind: string, extra = {}) => ({ id, origin: 'context', visibility: 'conversation', provenance: 'context', createdAt: when, sourceAliases: [id],
  context: { id, conversationId: 'room', authorId: 'morgan', author: { id: 'morgan', name: 'Morgan Example' }, kind, lane: 'context', text: `${kind} text`, revision: 1, createdAt: when, updatedAt: when, clientRequestId: id, ...extra } });
const entry = (id: string, visibility: 'conversation' | 'private', provenance: string, authorId = 'morgan') => ({ id, origin: 'stream', visibility, provenance, createdAt: when, sourceAliases: [id],
  thought: { id, text: `${id} text`, kind: 'observation', status: 'none', createdAt: when, updatedAt: when, tags: [], authorId, authorName: authorId === 'alice' ? 'Alice Example' : 'Morgan Example', pinned: provenance === 'pinned', collapsed: false } });

let tree: ReactTestRenderer | undefined;
const flatten = (node: unknown): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join(' ')
  : node && typeof node === 'object' && 'children' in node ? flatten((node as { children: unknown }).children) : '';
const lane = async (items: unknown[]) => {
  os.content.mockResolvedValue({ contextAvailable: true, items });
  await act(async () => { tree = create(React.createElement(ContextLane, { conversationId: 'room' })); });
  await act(async () => { await Promise.resolve(); });
};
/** The rendered text of each card, in order. */
const cards = () => (tree!.toJSON() as any).children.find((node: any) => node.type === 'List').children.map((node: unknown) => flatten(node).replace(/\s+/g, ' ')) as string[];
beforeEach(() => { vi.clearAllMocks(); os.platform = 'ios'; os.collapsed = false; });
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; });

describe('Stream cards say who can read them', () => {
  it('labels every shared thing the same way, whatever made it', async () => {
    await lane([post('p1', 'note'), post('p2', 'ask'), post('p3', 'offer'), entry('t1', 'conversation', 'message_capture'), entry('t2', 'conversation', 'pinned')]);
    const text = cards();
    expect(text).toHaveLength(5);
    for (const card of text) { expect(card).toContain('Shared with this chat'); expect(card).not.toContain('Only you'); expect(card).toContain('Morgan Example'); }
    expect(text.map(card => /· (Note|Ask|Offer|From a message|Pinned)/.exec(card)?.[1])).toEqual(['Note', 'Ask', 'Offer', 'From a message', 'Pinned']);
  });
  it('sets a private entry apart: lock label, tinted card, and never the shared label', async () => {
    await lane([entry('mine', 'private', 'private_note', 'alice'), entry('theirs', 'conversation', 'message_capture')]);
    const [mine, theirs] = cards();
    expect(mine).toContain('Private · Only you'); expect(mine).not.toContain('Shared with this chat'); expect(mine).toContain('You');
    expect(theirs).toContain('Shared with this chat'); expect(theirs).not.toContain('Private');
    const surfaces = tree!.root.findAll(node => node.type === 'TouchableOpacity' && node.props.accessibilityState && 'expanded' in node.props.accessibilityState && Array.isArray(node.props.style))
      .map(node => Object.assign({}, ...node.props.style.flat()).backgroundColor);
    expect(surfaces).toHaveLength(2); expect(surfaces[0]).not.toBe(surfaces[1]);
  });
  it('names the agent that wrote a post on its author’s behalf', async () => {
    await lane([post('p1', 'ask', { agent: { id: 'a', name: 'Workshop assistant' } }), post('p2', 'note')]);
    const [byAgent, byPerson] = cards();
    expect(byAgent).toContain('via Workshop assistant · Agent'); expect(byPerson).not.toContain('Agent');
  });
  it('offers exact time as a working button on posts, and as plain text where nothing would happen', async () => {
    await lane([post('p1', 'note'), entry('t1', 'conversation', 'message_capture')]);
    const buttons = tree!.root.findAll(node => node.type === 'Pressable' && String(node.props.accessibilityLabel).startsWith('Show exact time:'));
    expect(buttons).toHaveLength(1);
    await act(async () => { buttons[0]!.props.onPress(); });
    expect(flatten(tree!.toJSON())).toContain(new Date(when).toLocaleString());
  });
  it('opens and closes a post’s actions from its More button', async () => {
    await lane([post('p1', 'note')]);
    const more = () => tree!.root.findAll(node => node.type === 'TouchableOpacity' && ['More', 'Hide actions'].includes(node.props.accessibilityLabel))[0]!;
    expect(more().props.accessibilityState).toEqual({ expanded: false }); expect(cards()[0]).not.toContain('Reply');
    await act(async () => { more().props.onPress(); });
    expect(more().props.accessibilityLabel).toBe('Hide actions'); expect(more().props.accessibilityState).toEqual({ expanded: true }); expect(cards()[0]).toContain('Reply');
    await act(async () => { more().props.onPress(); });
    expect(cards()[0]).not.toContain('Reply');
  });
  it('keeps a deleted post free of actions', async () => {
    await lane([post('gone', 'note', { isDeleted: true })]);
    expect(cards()[0]).toContain('Post deleted'); expect(cards()[0]).not.toContain('More');
  });
});

it('the lane switch reads Chat | Stream and still selects the same lanes', async () => {
  const change = vi.fn();
  await act(async () => { tree = create(React.createElement(ConversationLaneSwitch, { activeLane: 'chat', onChange: change })); });
  const tabs = tree!.root.findAllByProps({ accessibilityRole: 'tab' }).filter(node => typeof node.type === 'string');
  expect(tabs.map(tab => tab.props.accessibilityLabel)).toEqual(['Chat', 'Stream']);
  expect(flatten(tree!.toJSON())).not.toContain('Context');
  await act(async () => { tabs[1]!.props.onPress(); });
  expect(change).toHaveBeenCalledWith('context');
});
