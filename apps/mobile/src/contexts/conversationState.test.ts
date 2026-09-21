import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../api/client';
import {
  applyMessageToConversationList,
  unreadCountsFromConversations,
  upsertConversation,
} from './conversationState';

const inboundConversation: Conversation = {
  id: 'new-dm',
  type: 'direct',
  unreadCount: 1,
  lastMessageAt: '2026-09-20T20:00:00.000Z',
  lastMessagePreview: 'first inbound',
};

describe('first inbound conversation state', () => {
  it('inserts a conversation:created payload into an empty recipient list', () => {
    expect(upsertConversation([], inboundConversation)).toEqual([inboundConversation]);
  });

  it('restores the unread signal from a cold conversation-list load', () => {
    expect(unreadCountsFromConversations([inboundConversation]))
      .toEqual(new Map([['new-dm', 1]]));
  });

  it('updates and promotes an existing conversation on message:new', () => {
    const older: Conversation = {
      id: 'older',
      type: 'direct',
      lastMessageAt: '2026-09-19T20:00:00.000Z',
    };
    const message: Message = {
      id: 'message-1',
      conversationId: 'older',
      senderId: 'sender-b',
      content: 'the first inbound message',
      createdAt: '2026-09-20T21:00:00.000Z',
    };

    const result = applyMessageToConversationList([inboundConversation, older], message);

    expect(result.found).toBe(true);
    expect(result.conversations[0]).toMatchObject({
      id: 'older',
      lastMessagePreview: 'the first inbound message',
      lastMessageAt: message.createdAt,
    });
  });

  it('signals when message:new belongs to a conversation not yet in state', () => {
    const message: Message = {
      id: 'message-2',
      conversationId: 'brand-new-dm',
      senderId: 'sender-b',
      content: 'hello',
      createdAt: '2026-09-20T22:00:00.000Z',
    };

    const result = applyMessageToConversationList([], message);

    expect(result.found).toBe(false);
    expect(result.conversations).toEqual([]);
  });
});
