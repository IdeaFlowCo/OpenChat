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

    const [, params] = run.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.tags).toEqual(['fact', 'decision']);
    expect(params.kind).toBe('fact'); // first tag's kind is primary
    expect(params.text).toBe('#fact #decision we ship Friday');
  });

  it('emits a single thought:created event carrying all tags', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const session = { run } as unknown as Session;
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as Parameters<
      typeof createThoughtsFromMessageTags
    >[1]['io'];

    await createThoughtsFromMessageTags(session, {
      senderId: 'user-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: '#fact #decision we ship Friday',
      io,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emit.mock.calls[0] as [string, { thought: { tags: string[]; kind: string } }];
    expect(eventName).toBe('thought:created');
    expect(payload.thought.tags).toEqual(['fact', 'decision']);
    expect(payload.thought.kind).toBe('fact');
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
