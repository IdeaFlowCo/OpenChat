/**
 * Links in the chat's Stream. Chat bubbles already opened web addresses; Back
 * channel posts and Stream entries printed them as dead text. All fixtures
 * here are synthetic.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filePaths, linkParts } from '../../mobile/src/utils/richLinks.js';

const os = vi.hoisted(() => ({ platform: 'ios', open: vi.fn(), content: vi.fn(), collapsed: false, copy: vi.fn(), notice: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return os.platform; }, select: (values: any) => values[os.platform] ?? values.default },
  Alert: { alert: vi.fn() }, Linking: { openURL: os.open },
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Modal: () => null, Pressable: 'Pressable', View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  FlatList: ({ data, renderItem }: any) => React.createElement('List', {}, data.map((item: any) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item })))),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: os.copy }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock('../../mobile/src/services/notice', () => ({ showNotice: os.notice }));
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
import { ThoughtCard } from '../../mobile/src/components/ThoughtCard';

// A reference note of the kind an agent writes: a title, a file on the author's
// computer on its own line (with spaces), and a web address followed by an arrow trail.
const PATH = '/Users/morgan/Documents/Workshop/2026 Autumn/Agenda Final/agenda.html';
const NOTE = `Workshop logistics\n\nAgenda file on Morgan’s laptop:\n${PATH}\n\nSignup sheet: https://signup.example.org/ → Autumn workshop → Volunteers.\n\nThe agenda file is only on that laptop.`;
const CAPTURE = '#link https://example.org/reading-list';
const when = '2026-11-20T00:00:00Z';
const post = (id: string, text: string, extra = {}) => ({ id, origin: 'context', visibility: 'conversation', provenance: 'context', createdAt: when, sourceAliases: [id],
  context: { id, conversationId: 'room', authorId: 'morgan', author: { id: 'morgan', name: 'Morgan Example' }, kind: 'note', lane: 'context', text, revision: 1, createdAt: when, updatedAt: when, clientRequestId: id, ...extra } });
const thought = (id: string, text: string) => ({ id, text, kind: 'observation' as const, status: 'none' as const, createdAt: when, updatedAt: when, tags: ['link'], authorId: 'morgan', authorName: 'Morgan Example', pinned: false, collapsed: false });
const entry = (id: string, text: string) => ({ id, origin: 'stream', visibility: 'conversation', provenance: 'message_capture', createdAt: when, sourceAliases: [id], thought: thought(id, text) });

let tree: ReactTestRenderer | undefined;
const links = () => tree!.root.findAllByProps({ accessibilityRole: 'link' }).filter(node => typeof node.type === 'string');
const body = () => tree!.root.findAll(node => node.type === 'Text' && 'selectable' in node.props)[0]!;
const flatten = (node: unknown): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join('')
  : node && typeof node === 'object' && 'children' in node ? flatten((node as { children: unknown }).children) : '';
const lane = async (items: unknown[]) => {
  os.content.mockResolvedValue({ contextAvailable: true, items });
  await act(async () => { tree = create(React.createElement(ContextLane, { conversationId: 'room' })); });
  await act(async () => { await Promise.resolve(); });
};
beforeEach(() => { vi.clearAllMocks(); os.platform = 'ios'; os.collapsed = false; os.open.mockResolvedValue(undefined); os.copy.mockResolvedValue(true); });
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; });

describe('Stream text parts', () => {
  it('finds the web address and the local file in a reference note, and loses no character', () => {
    const parts = linkParts(NOTE);
    expect(parts.filter(p => p.t === 'link')).toEqual([expect.objectContaining({ label: 'https://signup.example.org/', url: 'https://signup.example.org/' })]);
    expect(parts.flatMap(p => p.t === 'path' ? [p.path] : [])).toEqual([PATH]);
    expect(parts.map(p => p.source).join('')).toBe(NOTE);
  });
  it.each([
    ['Saved in ~/notes/plan.md, see also (/home/sam/a b.txt) and C:\\Users\\sam\\plan.docx.', ['~/notes/plan.md', '/home/sam/a', 'C:\\Users\\sam\\plan.docx']],
    ['/Volumes/Backup/Workshop Planning/index.html   \nnext line', ['/Volumes/Backup/Workshop Planning/index.html']],
    ['/tmp/build is where I left it\n~/notes has the rest', ['/tmp/build', '~/notes']],
    ['Folder:\n/Users/sam/My Notes/\nand then more', ['/Users/sam/My Notes/']],
    ['and/or /shrug 3/4 2026/11/20 either/or/Users/x https://example.org/Users/sam/file a/home/b ~ / ~/', []],
  ])('treats only device file locations as paths: %s', (content, expected) => {
    expect(filePaths(content).map(p => content.slice(p.start, p.end))).toEqual(expected);
    expect(linkParts(content).map(p => p.source).join('')).toBe(content);
  });
  it('never turns a file location or an unsafe scheme into a link', () => {
    const content = 'file:///Users/sam/a.html javascript:alert(1) /Users/sam/site.com/index.html';
    const parts = linkParts(content);
    expect(parts.filter(p => p.t === 'link')).toEqual([]);
    expect(parts.flatMap(p => p.t === 'path' ? [p.path] : [])).toEqual(['/Users/sam/a.html', '/Users/sam/site.com/index.html']);
  });
  it('stays linear on a long run of slashes and dots', () => {
    const started = Date.now(); linkParts(('/Users/' + 'a/'.repeat(4000) + ' ').repeat(5) + 'x.'.repeat(5000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('Back channel posts', () => {
  it('opens the web address in a person’s note and shows the local file as a path, not a link', async () => {
    await lane([post('p1', NOTE)]);
    expect(links().map(node => flatten(node.props.children))).toEqual(['https://signup.example.org/']);
    await act(async () => { links()[0]!.props.onPressIn(); links()[0]!.props.onPress({ stopPropagation: vi.fn() }); });
    expect(os.open).toHaveBeenCalledWith('https://signup.example.org/');
    // The file on the author's laptop is something to copy, never something to open.
    const path = tree!.root.findAll(node => node.type === 'Text' && node.props.accessibilityLabel === `Copy file path: ${PATH}`)[0]!;
    expect(path.props.href).toBeUndefined(); os.open.mockClear();
    await act(async () => { path.props.onPress({ stopPropagation: vi.fn() }); });
    expect(os.copy).toHaveBeenCalledWith(PATH); expect(os.open).not.toHaveBeenCalled();
    expect(os.notice).toHaveBeenCalledWith('Path copied: paste in Finder (⇧⌘G)');
    // Paragraphs are separate blocks now; every character of the note is still there.
    expect(flatten(tree!.toJSON()).replace('📁\u00a0', '')).toContain(NOTE.replace(/\n\n/g, ''));
  });
  it('holding a link opens the post actions instead of the address', async () => {
    await lane([post('p1', 'See https://example.org/a')]);
    await act(async () => { links()[0]!.props.onPressIn(); links()[0]!.props.onLongPress(); links()[0]!.props.onPress({ stopPropagation: vi.fn() }); });
    expect(os.open).not.toHaveBeenCalled();
    expect(flatten(tree!.toJSON())).toContain('Hide actions');
  });
  it('renders an agent’s post as Markdown; a person’s post gets links by the same rules but no other formatting', async () => {
    const text = 'Who can review the **speaker list**? See [the draft](https://docs.example.com/speakers) or www.example.net/agenda.';
    await lane([post('agent', text, { agent: { id: 'a', name: 'Workshop assistant' } }), post('person', text)]);
    const all = flatten(tree!.toJSON());
    expect(all).toContain('Who can review the speaker list? See the draft or www.example.net/agenda.');
    expect(all).toContain('Who can review the **speaker list**? See the draft or www.example.net/agenda.');
    // An agent's post stays selectable, as a person's is.
    expect(tree!.root.findAll(node => node.type === 'Text' && node.props.selectable === true).length).toBeGreaterThanOrEqual(2);
    await act(async () => { for (const link of links()) { link.props.onPressIn?.(); link.props.onPress({ stopPropagation: vi.fn() }); } });
    expect(os.open.mock.calls.map(call => call[0])).toEqual(['https://docs.example.com/speakers', 'https://www.example.net/agenda', 'https://docs.example.com/speakers', 'https://www.example.net/agenda']);
  });
  it('exposes no link in a deleted post', async () => {
    await lane([post('gone', 'https://example.org/secret', { isDeleted: true })]);
    expect(links()).toEqual([]); expect(flatten(tree!.toJSON())).not.toContain('example.org');
  });
  it('opens the web address in a Stream entry captured from a message', async () => {
    await lane([entry('t1', CAPTURE)]);
    expect(links()).toHaveLength(1);
    await act(async () => { links()[0]!.props.onPressIn(); links()[0]!.props.onPress({ stopPropagation: vi.fn() }); });
    expect(os.open).toHaveBeenCalledWith('https://example.org/reading-list');
  });
});

describe('Stream cards', () => {
  it('opens a link without also triggering the card, and a hold opens the card actions', async () => {
    const edit = vi.fn();
    await act(async () => { tree = create(React.createElement(ThoughtCard, { item: thought('t1', CAPTURE), onPress: edit })); });
    const event = { stopPropagation: vi.fn() };
    await act(async () => { links()[0]!.props.onPressIn(); links()[0]!.props.onPress(event); });
    expect(os.open).toHaveBeenCalledWith('https://example.org/reading-list'); expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(edit).not.toHaveBeenCalled();
    os.open.mockClear();
    await act(async () => { links()[0]!.props.onPressIn(); links()[0]!.props.onLongPress(); links()[0]!.props.onPress(event); });
    expect(os.open).not.toHaveBeenCalled();
  });
  it('keeps native text unselectable so a tap still reaches the card', async () => {
    await act(async () => { tree = create(React.createElement(ThoughtCard, { item: thought('t1', CAPTURE), onPress: vi.fn() })); });
    expect(body().props.selectable).toBe(false);
  });
  it('is a real anchor on web: new tab, no opener, selection wins over activation', async () => {
    os.platform = 'web';
    await act(async () => { tree = create(React.createElement(ThoughtCard, { item: thought('t1', CAPTURE) })); });
    const link = links()[0]!;
    expect(link.props.href).toBe('https://example.org/reading-list');
    expect(link.props.hrefAttrs).toEqual({ target: '_blank', rel: 'noopener noreferrer' });
    expect(body().props.selectable).toBe(true);
    link.props.onPress({ stopPropagation: vi.fn(), preventDefault: vi.fn() }); expect(os.open).not.toHaveBeenCalled();
  });
  it('shows a collapsed entry as one plain line with no link', async () => {
    os.collapsed = true;
    await act(async () => { tree = create(React.createElement(ThoughtCard, { item: thought('t1', CAPTURE) })); });
    expect(links()).toEqual([]); expect(flatten(tree!.toJSON())).toContain(CAPTURE);
  });
});
