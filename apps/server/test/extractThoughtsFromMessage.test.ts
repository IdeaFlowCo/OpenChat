import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'neo4j-driver';
import {
  createThoughtsFromMessageTags,
  extractTagsFromMessage,
} from '../src/services/extractThoughtsFromMessage.js';

describe('extractTagsFromMessage', () => {
  it('extracts all tags from a multi-tag message, in source order', () => {
    const tags = extractTagsFromMessage('#fact #decision we ship Friday');
    expect(tags.map((t) => t.name)).toEqual(['fact', 'decision']);
    expect(tags.map((t) => t.kind)).toEqual(['fact', 'decision']);
  });

  it('dedupes the same tag repeated in one message', () => {
    const tags = extractTagsFromMessage('#fact #fact #fact same fact three times');
    expect(tags.map((t) => t.name)).toEqual(['fact']);
  });

  it('caps at MAX_TAGS_PER_MESSAGE', () => {
    const tags = extractTagsFromMessage('#a #b #c #d #e #f #g spam');
    expect(tags.length).toBe(5);
  });
});

describe('createThoughtsFromMessageTags', () => {
  it('creates exactly ONE Thought for a message with two tags (OpenChat-kb7f)', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const session = { run } as unknown as Session;

    const ids = await createThoughtsFromMessageTags(session, {
      senderId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: '#fact #decision we ship Friday',
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(ids).toHaveLength(1);

    const [query, params] = run.mock.calls[0] as [string, Record<string, unknown>];
    // captureMethod is now a parameter, since a reply's tags capture the parent.
    expect(query).toContain('captureMethod: $captureMethod');
    expect(params.captureMethod).toBe('inline-tag');
    expect(params.viaMessageId).toBeNull();
    expect(params.targetMessageId).toBe('msg-1');
    expect(params.tags).toEqual(['fact', 'decision']);
    expect(params.kind).toBe('fact'); // first tag's kind is primary
    expect(params.text).toBe('#fact #decision we ship Friday');
  });

  it('emits the tagged thought to the author and the whole conversation', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const session = { run } as unknown as Session;
    const personalEmit = vi.fn();
    const conversationEmit = vi.fn();
    const to = vi.fn((room: string) => ({
      emit: room.startsWith('user:') ? personalEmit : conversationEmit,
    }));
    const io = { to } as unknown as Parameters<
      typeof createThoughtsFromMessageTags
    >[1]['io'];

    await createThoughtsFromMessageTags(session, {
      senderId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: '#fact #decision we ship Friday',
      io,
    });

    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(to).toHaveBeenCalledWith('conversation:conv-1');
    expect(personalEmit).toHaveBeenCalledWith(
      'thought:created',
      expect.objectContaining({
        thought: expect.objectContaining({
          tags: ['fact', 'decision'],
          kind: 'fact',
          authorId: 'user-1',
        }),
      }),
    );
    expect(conversationEmit).toHaveBeenCalledWith(
      'thought:shared',
      expect.objectContaining({
        conversationId: 'conv-1',
        thought: expect.objectContaining({
          tags: ['fact', 'decision'],
          kind: 'fact',
          authorId: 'user-1',
        }),
      }),
    );
  });

  it('returns no ids and does not throw when there are no tags', async () => {
    const run = vi.fn();
    const session = { run } as unknown as Session;

    const ids = await createThoughtsFromMessageTags(session, {
      senderId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: 'no tags in this message at all',
    });

    expect(ids).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
