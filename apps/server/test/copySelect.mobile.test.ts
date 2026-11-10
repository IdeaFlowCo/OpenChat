// Copy / select / edit audit (2026-11): every authored-text surface either
// selects in place or offers an explicit Copy, on native and web.
// See docs/audits/2026-11-copy-select-edit-audit.md.
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'web',
  setStringAsync: vi.fn(async (_text: string) => true),
  getThoughtContext: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return mocks.os; }, select: (v: any) => v[mocks.os] ?? v.default },
  Appearance: { getColorScheme: () => 'light' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Alert: { alert: mocks.alert },
  Linking: { openURL: vi.fn(async () => true) },
  ActivityIndicator: 'ActivityIndicator',
  Modal: ({ visible, children }: any) => (visible ? children : null),
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => mocks.setStringAsync(text) }));
vi.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { thoughtId: 'thought-1' } }),
  CommonActions: { navigate: (x: unknown) => x },
}));
vi.mock('../../mobile/src/services/notifications', () => ({ navigationRef: { dispatch: vi.fn() } }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getThoughtContext: (id: string) => mocks.getThoughtContext(id) } }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/components/ReactionPicker', () => ({ ReactionPicker: () => null }));
vi.mock('../../mobile/src/components/MessageLinkActions', () => ({ MessageLinkActions: () => null }));
vi.mock('../../mobile/src/services/streamDisplay', () => ({
  COMPACT_VISIBLE_LINES: 4,
  isLongStreamText: () => false,
  useStreamCompact: () => [false, vi.fn()],
  useThoughtCollapsed: () => [false, vi.fn(async () => undefined)],
}));

import { copyText, hasActiveTextSelection, messageCopyText } from '../../mobile/src/utils/copyText.js';
import { ThoughtCard } from '../../mobile/src/components/ThoughtCard.js';
import { VisionNoteCard } from '../../mobile/src/components/VisionNoteCard.js';
import { MessageActionSheet } from '../../mobile/src/components/MessageActionSheet.js';
import { OriginalMessageScreen } from '../../mobile/src/screens/OriginalMessageScreen.js';

let screen: ReactTestRenderer | undefined;
const render = async (element: React.ReactElement) => { await act(async () => { screen = create(element); }); };
const textOf = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
/** Innermost touchable whose label is exactly `label`. */
const button = (label: string) => screen!.root.findAllByType('TouchableOpacity' as any)
  .filter(node => node.findAllByType('Text' as any).some(text => textOf(text) === label)).at(-1)!;
const hasButton = (label: string) => screen!.root.findAllByType('TouchableOpacity' as any)
  .some(node => node.findAllByType('Text' as any).some(text => textOf(text) === label));
const textNode = (content: string) => screen!.root.findAllByType('Text' as any).find(node => textOf(node) === content)!;
const press = async (label: string) => { await act(async () => { await button(label).props.onPress(); }); };

const thought = { id: 'thought-1', text: 'Green tea with Ana on Friday #tea', kind: 'observation', status: 'none', tags: ['tea'], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } as any;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.os = 'ios';
  mocks.setStringAsync.mockReset();
  mocks.setStringAsync.mockResolvedValue(true);
  mocks.alert.mockReset();
  delete (globalThis as any).getSelection;
});
afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
});

describe('copy helpers', () => {
  it('copies through expo-clipboard and reports failure without throwing', async () => {
    expect(await copyText('hello')).toBe(true);
    expect(mocks.setStringAsync).toHaveBeenCalledWith('hello');
    mocks.setStringAsync.mockRejectedValueOnce(new Error('denied'));
    expect(await copyText('hello')).toBe(false);
    expect(await copyText('')).toBe(false);
  });
  it('offers a voice transcript when a message has no text, and nothing for deleted messages', () => {
    expect(messageCopyText({ content: 'hi' })).toBe('hi');
    expect(messageCopyText({ content: '', transcript: 'spoken words' })).toBe('spoken words');
    expect(messageCopyText({ content: '  ' })).toBe('');
    expect(messageCopyText({ content: 'gone', deletedAt: '2026-11-01' })).toBe('');
  });
  it('detects a browser text selection only on web', () => {
    (globalThis as any).getSelection = () => ({ isCollapsed: false, toString: () => 'tea' });
    expect(hasActiveTextSelection()).toBe(false);
    mocks.os = 'web';
    expect(hasActiveTextSelection()).toBe(true);
    (globalThis as any).getSelection = () => ({ isCollapsed: true, toString: () => '' });
    expect(hasActiveTextSelection()).toBe(false);
  });
});

describe('Stream entry (ThoughtCard)', () => {
  const card = (props: Record<string, unknown> = {}) => React.createElement(ThoughtCard, { item: thought, ...props });
  const longPress = async () => { await act(async () => { screen!.root.findAllByType('TouchableOpacity' as any)[0].props.onLongPress(); }); };

  it('long-press offers Copy text, which copies the entry text', async () => {
    await render(card({ onPress: vi.fn() }));
    await longPress();
    await press('Copy text');
    expect(mocks.setStringAsync).toHaveBeenCalledWith(thought.text);
  });
  it('Select text… shows the full entry selectable, in the same menu Modal, with Copy all', async () => {
    await render(card());
    await longPress();
    await press('Select text…');
    const body = screen!.root.findAll(node => node.props.testID === 'selectable-text-sheet-body' && typeof node.type === 'string')[0];
    expect(body.props.selectable).toBe(true);
    expect(textOf(body)).toBe(thought.text);
    expect(hasButton('Copy text')).toBe(false);
    await press('Copy all');
    expect(mocks.setStringAsync).toHaveBeenCalledWith(thought.text);
    expect(JSON.stringify(screen!.toJSON())).toContain('Copied');
  });
  it('owner entries keep Edit entry; read-only entries still get Copy text', async () => {
    const edit = vi.fn();
    await render(card({ onPress: edit }));
    await longPress();
    await press('Edit entry');
    expect(edit).toHaveBeenCalledTimes(1);
    await act(async () => { screen!.unmount(); });
    await render(card());
    await longPress();
    expect(hasButton('Edit entry')).toBe(false);
    expect(hasButton('Copy text')).toBe(true);
  });
  it('native: body is not selectable in place (the card owns the gestures); tap still edits', async () => {
    const edit = vi.fn();
    await render(card({ onPress: edit }));
    expect(textNode(thought.text).props.selectable).toBe(false);
    await act(async () => { screen!.root.findAllByType('TouchableOpacity' as any)[0].props.onPress(); });
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it('web: body selects in place, and finishing a selection does not start editing', async () => {
    mocks.os = 'web';
    const edit = vi.fn();
    await render(card({ onPress: edit }));
    expect(textNode(thought.text).props.selectable).toBe(true);
    (globalThis as any).getSelection = () => ({ isCollapsed: false, toString: () => 'Green tea' });
    await act(async () => { screen!.root.findAllByType('TouchableOpacity' as any)[0].props.onPress(); });
    expect(edit).not.toHaveBeenCalled();
    (globalThis as any).getSelection = () => ({ isCollapsed: true, toString: () => '' });
    await act(async () => { screen!.root.findAllByType('TouchableOpacity' as any)[0].props.onPress(); });
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it('web: right-click over a selection keeps the browser menu; otherwise opens entry actions', async () => {
    mocks.os = 'web';
    await render(card());
    const wrapper = screen!.root.findAll(node => typeof node.props.onContextMenu === 'function')[0];
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (globalThis as any).getSelection = () => ({ isCollapsed: false, toString: () => 'tea' });
    await act(async () => { wrapper.props.onContextMenu(event); });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(hasButton('Copy text')).toBe(false);
    (globalThis as any).getSelection = () => ({ isCollapsed: true, toString: () => '' });
    await act(async () => { wrapper.props.onContextMenu(event); });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(hasButton('Copy text')).toBe(true);
  });
});

describe('Vision search result (VisionNoteCard)', () => {
  const row = { id: 'v1', text: 'Matcha notes from Kyoto', title: 'Matcha', createdAt: '2026-06-01T00:00:00Z', url: 'https://vision.ideaflow.app/n/v1', sourcePlatform: null, sourceLink: null, tags: ['tea'] };
  it('text is selectable and Copy copies the note text', async () => {
    await render(React.createElement(VisionNoteCard, { row }));
    expect(textNode(row.text).props.selectable).toBe(true);
    expect(textNode(row.title).props.selectable).toBe(true);
    await press('Copy');
    expect(mocks.setStringAsync).toHaveBeenCalledWith(row.text);
    expect(hasButton('Copied')).toBe(true);
    expect(hasButton('Open in Vision')).toBe(true);
  });
});

describe('Original message screen', () => {
  it('message text is selectable and each message has Copy', async () => {
    mocks.getThoughtContext.mockResolvedValue({
      conversation: { id: 'c1', name: 'Tea club', type: 'group' }, messageId: 'm2',
      messages: [
        { id: 'm1', content: 'Anyone for tea?', createdAt: '2026-11-01T00:00:00Z', senderName: 'Ana' },
        { id: 'm2', content: 'Yes — oolong #tea', createdAt: '2026-11-01T00:01:00Z', senderName: 'Jacob' },
      ],
    });
    await render(React.createElement(OriginalMessageScreen));
    expect(mocks.getThoughtContext).toHaveBeenCalledWith('thought-1');
    expect(textNode('Yes — oolong #tea').props.selectable).toBe(true);
    expect(textNode('Anyone for tea?').props.selectable).toBe(true);
    await press('Copy saved message');
    expect(mocks.setStringAsync).toHaveBeenLastCalledWith('Yes — oolong #tea');
    await press('Copy');
    expect(mocks.setStringAsync).toHaveBeenLastCalledWith('Anyone for tea?');
  });
});

describe('Chat message actions (MessageActionSheet)', () => {
  const sheet = (message: Record<string, unknown>) => React.createElement(MessageActionSheet as any, {
    visible: true, isOwn: false, senderName: 'Ana', onDismiss: vi.fn(), onReply: vi.fn(), onForward: vi.fn(),
    onForwardToAssistant: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onReact: vi.fn(), onBlock: vi.fn(), onReport: vi.fn(),
    message: { id: 'm1', conversationId: 'c1', senderId: 'ana', createdAt: '2026-11-01T00:00:00Z', ...message },
  });
  it('Copy uses expo-clipboard with the message text', async () => {
    await render(sheet({ content: 'Shall we get tea?' }));
    await press('Copy');
    expect(mocks.setStringAsync).toHaveBeenCalledWith('Shall we get tea?');
  });
  it('Select text… shows the whole message selectable', async () => {
    await render(sheet({ content: 'A long message worth quoting in part' }));
    await press('Select text…');
    const body = screen!.root.findAll(node => node.props.testID === 'selectable-text-sheet-body' && typeof node.type === 'string')[0];
    expect(body.props.selectable).toBe(true);
    expect(textOf(body)).toBe('A long message worth quoting in part');
  });
  it('voice messages copy their transcript; attachment-only messages offer no empty Copy', async () => {
    await render(sheet({ content: '', transcript: 'meet at the tea house' }));
    await press('Copy transcript');
    expect(mocks.setStringAsync).toHaveBeenCalledWith('meet at the tea house');
    await act(async () => { screen!.unmount(); });
    await render(sheet({ content: '', attachments: [{ type: 'image', url: 'https://x/y.jpg' }] }));
    expect(hasButton('Copy')).toBe(false);
    expect(hasButton('Select text…')).toBe(false);
  });
});
