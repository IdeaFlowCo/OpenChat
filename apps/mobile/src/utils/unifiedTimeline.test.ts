import { describe, expect, it } from 'vitest';
import type { ConversationSource, Message, SourceMessage } from '../api/client';
import { mergeTimeline, mirroredEntries, mirrorModeLabel } from './unifiedTimeline';

const source = (overrides: Partial<ConversationSource> = {}): ConversationSource => ({
  id: 's1', network: 'imessage', title: 'Synthetic group', sharedAt: '2026-11-01T00:00:00.000Z', sharedBy: { userId: 'owner', name: 'Owner Account' },
  coverage: { asOf: null, earliestMessageAt: null, latestMessageAt: null, complete: false }, messageCount: 0, participants: [], ...overrides,
});
const mirrored = (id: string, sentAt: string, sender: SourceMessage['sender'] = { participantId: 'p-ada', label: 'Ada Example', isSharer: false }): SourceMessage =>
  ({ id, sentAt, kind: 'text', text: id, mediaType: null, edited: false, editedAt: null, deletedAtSource: null, sender });
const message = (id: string, createdAt: string, senderId = 'owner') => ({ id, createdAt, senderId, conversationId: 'c1', content: id }) as unknown as Message;
const keys = (entries: ReturnType<typeof mergeTimeline>) => entries.map(entry => entry.kind === 'message' ? entry.message.id : entry.mirror.message.id);

describe('mirrored entries', () => {
  it('shows the sharer under their account name and marks their own side only for them', () => {
    const fromSharer = mirrored('a', '2026-11-01T10:00:00.000Z', { participantId: 'p-owner', label: 'Owner Example', isSharer: true });
    const fromAda = mirrored('b', '2026-11-01T10:01:00.000Z');
    const unknown = mirrored('c', '2026-11-01T10:02:00.000Z', null);
    const forOwner = mirroredEntries(source(), [fromSharer, fromAda, unknown], 'owner');
    expect(forOwner.map(entry => [entry.senderLabel, entry.isOwn])).toEqual([['Owner Account', true], ['Ada Example', false], ['Unknown sender', false]]);
    expect(mirroredEntries(source(), [fromSharer], 'member')[0]).toMatchObject({ senderLabel: 'Owner Account', isOwn: false, key: 'mirror:s1:a' });
    // No account name on file: fall back to the name in the source chat.
    expect(mirroredEntries(source({ sharedBy: { userId: 'owner', name: null } }), [fromSharer], undefined)[0]).toMatchObject({ senderLabel: 'Owner Example', isOwn: false });
  });
});

describe('merged timeline', () => {
  const entries = mirroredEntries(source(), [mirrored('i2', '2026-11-01T10:05:00.000Z'), mirrored('i1', '2026-11-01T09:00:00.000Z'), mirrored('i3', '2026-11-01T12:00:00.000Z')], 'owner');
  const messages = [message('o1', '2026-11-01T10:00:00.000Z'), message('o2', '2026-11-01T11:00:00.000000000Z')];

  it('interleaves by time in the unified view, oldest first', () => {
    expect(keys(mergeTimeline(messages, entries, 'unified', false))).toEqual(['i1', 'o1', 'i2', 'o2', 'i3']);
  });
  it('filters to one side', () => {
    expect(keys(mergeTimeline(messages, entries, 'openchat', false))).toEqual(['o1', 'o2']);
    expect(keys(mergeTimeline(messages, entries, 'mirror', false))).toEqual(['i1', 'i2', 'i3']);
  });
  it('holds back mirrored messages older than the loaded OpenChat page while older pages remain', () => {
    expect(keys(mergeTimeline(messages, entries, 'unified', true))).toEqual(['o1', 'i2', 'o2', 'i3']);
    // The mirror-only view is not paged by OpenChat history.
    expect(keys(mergeTimeline(messages, entries, 'mirror', true))).toEqual(['i1', 'i2', 'i3']);
  });
  it('shows the whole mirror in a conversation with no OpenChat messages yet', () => {
    expect(keys(mergeTimeline([], entries, 'unified', false))).toEqual(['i1', 'i2', 'i3']);
    expect(mergeTimeline(messages, [], 'unified', false)).toHaveLength(2);
  });
  it('puts a mirrored message first when both carry the same instant', () => {
    const tie = mirroredEntries(source(), [mirrored('i0', '2026-11-01T10:00:00.000Z')], 'owner');
    expect(keys(mergeTimeline(messages, tie, 'unified', false))).toEqual(['i0', 'o1', 'o2']);
  });
});

describe('switch wording', () => {
  it('names the network when there is one, else says Mirrored', () => {
    expect(mirrorModeLabel([{ network: 'imessage' }])).toBe('iMessage');
    expect(mirrorModeLabel([{ network: 'imessage' }, { network: 'imessage' }])).toBe('iMessage');
    expect(mirrorModeLabel([{ network: 'imessage' }, { network: 'whatsapp' }])).toBe('Mirrored');
    expect(mirrorModeLabel([{ network: 'matrix' }])).toBe('Matrix');
  });
});
