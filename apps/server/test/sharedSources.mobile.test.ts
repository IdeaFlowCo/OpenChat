import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { listConversationResources: vi.fn(), updateConversationResource: vi.fn(), setConversationResourceSaved: vi.fn() },
  openLink: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View', ScrollView: 'ScrollView',
  Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() },
  FlatList: ({ data, renderItem, ListEmptyComponent, ListFooterComponent }: any) => React.createElement('FlatList', null,
    data?.length ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: item.id ?? index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent),
}));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'me' } }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: mocks.api }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { ConversationLaneSwitch } from '../../mobile/src/components/ConversationLaneSwitch.js';
import { ConversationSourceBar } from '../../mobile/src/components/ConversationSourceBar.js';
import { MirroredMessageRow } from '../../mobile/src/components/MirroredMessageRow.js';
import { ResourcesLane } from '../../mobile/src/components/ResourcesLane.js';

const resource = (id: string, extra: Record<string, unknown> = {}) => ({
  id, url: `https://example.org/${id}`, host: 'example.org', kind: 'link', kindEdited: false, title: `Title ${id}`, description: null, siteName: null, tags: [], suggestedTags: [], tagsEdited: false,
  firstSharedAt: '2026-11-09T12:00:00.000Z', lastSharedAt: '2026-11-09T12:00:00.000Z', firstSharedBy: { label: 'Ada Example', userId: null }, shareCount: 1, sources: ['imessage'], saved: false, savedCount: 0, ...extra,
});
const paper = resource('paper', { kind: 'paper', title: 'Shared Knowledge Graphs', tags: ['research', 'hci'], suggestedTags: ['research', 'hci'], host: 'dl.acm.org' });
const person = resource('person', { kind: 'person', title: 'Ada Example', tags: ['researcher'], saved: true, savedCount: 1 });

let root: ReturnType<typeof create> | undefined;
const texts = () => root!.root.findAllByType('Text' as any).map(node => node.children.flat().map(child => typeof child === 'string' ? child : '').join('')).join('\n');
const byLabel = (label: string): ReactTestInstance => {
  const found = root!.root.findAll(node => node.type === ('TouchableOpacity' as any) && node.props.accessibilityLabel === label);
  if (!found.length) throw new Error(`No control labelled ${label}`);
  return found[0]!;
};
const byTestId = (id: string): ReactTestInstance => root!.root.findAll(node => node.props.testID === id && typeof node.type === 'string')[0]!;
async function render(element: React.ReactElement) { await act(async () => { root = create(element); }); }
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onPress(); }); };

beforeEach(() => {
  vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.listConversationResources.mockResolvedValue({ enabled: true, resources: [paper, person], pending: 0 });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; });

describe('Links lane', () => {
  it('lists each link with its kind, suggested tags, who shared it and where', async () => {
    await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
    expect(mocks.api.listConversationResources).toHaveBeenCalledWith('c1');
    const shown = texts();
    expect(shown).toContain('Shared Knowledge Graphs');
    expect(shown).toContain('Paper · suggested');
    expect(shown).toContain('#research');
    expect(shown).toContain('Suggested');
    expect(shown).toMatch(/Shared by Ada Example · .+ · iMessage/);
    expect(shown).toContain('All 2');
    expect(shown).toContain('Saved 1');
    expect(shown).toContain('example.org · Saved by 1');
  });

  it('saves and unsaves for the member, and puts the mark back when the server refuses', async () => {
    mocks.api.setConversationResourceSaved.mockResolvedValueOnce({ resource: { ...paper, saved: true, savedCount: 1 } });
    await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
    await press(byLabel('Save Shared Knowledge Graphs'));
    expect(mocks.api.setConversationResourceSaved).toHaveBeenCalledWith('c1', 'paper', true);
    expect(texts()).toContain('Saved 2');
    mocks.api.setConversationResourceSaved.mockRejectedValueOnce(new Error('offline'));
    await press(byLabel('Saved. Remove Shared Knowledge Graphs from your saved links'));
    expect(texts()).toContain('Saved 2');
    expect(texts()).toContain('Could not update Saved. Try again.');
  });

  it('filters by Saved, kind and a tapped tag', async () => {
    await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
    await press(byTestId('resources-filter-saved'));
    expect(texts()).not.toContain('Shared Knowledge Graphs');
    expect(texts()).toContain('Ada Example');
    await press(byTestId('resources-filter-all'));
    await press(byLabel('Show links tagged hci'));
    expect(texts()).toContain('Shared Knowledge Graphs');
    expect(texts()).not.toContain('Title person');
    expect(texts()).toContain('#hci ×');
    await press(byLabel('Clear tag filter hci'));
    await press(byLabel('Person 1'));
    expect(texts()).not.toContain('Shared Knowledge Graphs');
  });

  it('edits tags and kind for everyone in the chat', async () => {
    mocks.api.updateConversationResource.mockResolvedValue({ resource: { ...paper, tags: ['reading-list', 'hci'], tagsEdited: true, kind: 'article', kindEdited: true } });
    await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
    await press(byTestId('resource-edit-paper'));
    const input = byTestId('resource-tags-input-paper');
    expect(input.props.value).toBe('research, hci');
    await act(async () => { input.props.onChangeText('#Reading-List, hci hci'); });
    await press(byLabel('Article'));
    await press(byTestId('resource-tags-save-paper'));
    expect(mocks.api.updateConversationResource).toHaveBeenCalledWith('c1', 'paper', { tags: ['reading-list', 'hci'], kind: 'article' });
    const shown = texts();
    expect(shown).toContain('#reading-list');
    expect(shown).toContain('Tags updated for everyone in this chat.');
    expect(shown).toContain('Article');
    expect(shown).not.toContain('Article · suggested');
  });

  it('keeps the editor open with the reason when a tag is refused', async () => {
    mocks.api.updateConversationResource.mockRejectedValue(new Error('"a/b" is not a usable tag.'));
    await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
    await press(byTestId('resource-edit-paper'));
    await act(async () => { byTestId('resource-tags-input-paper').props.onChangeText('a/b'); });
    await press(byTestId('resource-tags-save-paper'));
    expect(texts()).toContain('"a/b" is not a usable tag.');
    expect(byTestId('resource-tags-input-paper')).toBeTruthy();
  });

  it('explains itself when empty and offers a retry when loading fails', async () => {
    mocks.api.listConversationResources.mockResolvedValueOnce({ enabled: true, resources: [], pending: 0 });
    await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
    expect(texts()).toContain('Links shared in this chat are kept here');
    await act(async () => { root!.unmount(); });
    mocks.api.listConversationResources.mockRejectedValueOnce(new Error('Could not do that. Try again.'));
    await render(React.createElement(ResourcesLane, { conversationId: 'c2' }));
    expect(texts()).toContain('Could not do that. Try again.');
    await press(byLabel('Try again'));
    expect(texts()).toContain('Shared Knowledge Graphs');
  });
});

describe('source switch and mirrored rows', () => {
  it('offers Unified, OpenChat and the mirrored network by name', async () => {
    const onChange = vi.fn();
    await render(React.createElement(ConversationSourceBar, { mode: 'unified', onChange, mirrorLabel: 'iMessage', note: 'iMessage messages are a read-only mirror.' }));
    expect(texts()).toBe('Unified\nOpenChat\niMessage\niMessage messages are a read-only mirror.');
    expect(byLabel('Unified: OpenChat and iMessage together').props.accessibilityState).toEqual({ checked: true });
    await press(byLabel('iMessage only'));
    await press(byLabel('OpenChat only'));
    expect(onChange.mock.calls).toEqual([['mirror'], ['openchat']]);
  });

  it('shows the Links tab only where the conversation keeps links', async () => {
    const onChange = vi.fn();
    await render(React.createElement(ConversationLaneSwitch, { activeLane: 'chat', onChange }));
    expect(texts()).toBe('Chat\nContext');
    await act(async () => { root!.update(React.createElement(ConversationLaneSwitch, { activeLane: 'links', onChange, showLinks: true })); });
    expect(texts()).toBe('Chat\nContext\nLinks');
    expect(byLabel('Links').props.accessibilityState).toEqual({ selected: true });
    await press(byLabel('Context'));
    expect(onChange).toHaveBeenCalledWith('context');
  });

  it('labels a mirrored message with its sender and network, and never as an OpenChat message', async () => {
    const entry = { key: 'mirror:s1:m1', sourceId: 's1', network: 'imessage', isOwn: false, senderLabel: 'Ada Example', senderKey: 's1:p-ada',
      message: { id: 'm1', sentAt: '2026-11-09T23:40:04.000Z', kind: 'text', text: 'See https://example.org/a', mediaType: null, edited: true, editedAt: null, deletedAtSource: null, sender: { participantId: 'p-ada', label: 'Ada Example', isSharer: false } } };
    await render(React.createElement(MirroredMessageRow, { entry: entry as any, showSender: true }));
    const shown = texts();
    expect(shown).toContain('Ada Example');
    expect(shown).toContain('https://example.org/a');
    expect(shown).toMatch(/iMessage · .+ · Edited/);
    await act(async () => { root!.update(React.createElement(MirroredMessageRow, { entry: { ...entry, isOwn: true, message: { ...entry.message, kind: 'deleted', text: null, edited: false } } as any, showSender: true })); });
    expect(texts()).toContain('You');
    expect(texts()).toContain('Deleted by the sender on iMessage');
  });
});

it('loads another page of links on request', async () => {
  mocks.api.listConversationResources.mockResolvedValueOnce({ enabled: true, resources: [paper], pending: 0, nextCursor: 'next' }).mockResolvedValueOnce({ enabled: true, resources: [person], pending: 0, nextCursor: null });
  await render(React.createElement(ResourcesLane, { conversationId: 'c1' }));
  await press(byLabel('Load more links'));
  expect(mocks.api.listConversationResources).toHaveBeenLastCalledWith('c1', 'next');
  expect(texts()).toContain('Shared Knowledge Graphs');
  expect(texts()).toContain('Ada Example');
});
