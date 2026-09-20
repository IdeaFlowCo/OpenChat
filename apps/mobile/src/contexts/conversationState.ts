import type { Conversation, Message } from '../api/client';

export function sortConversationsByRecent(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    const aT = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bT = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bT - aT;
  });
}

/** Seed local unread state from the authoritative conversation-list response. */
export function unreadCountsFromConversations(list: Conversation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const conversation of list) {
    const count = conversation.unreadCount ?? 0;
    if (count > 0) counts.set(conversation.id, count);
  }
  return counts;
}

export function upsertConversation(
  list: Conversation[],
  conversation: Conversation,
): Conversation[] {
  const index = list.findIndex(item => item.id === conversation.id);
  if (index < 0) return sortConversationsByRecent([conversation, ...list]);
  const next = [...list];
  next[index] = { ...next[index], ...conversation };
  return sortConversationsByRecent(next);
}

/**
 * Apply the list-facing part of message:new. A false `found` result tells the
 * caller to fetch the conversation metadata before inserting the new row.
 */
export function applyMessageToConversationList(
  list: Conversation[],
  message: Message,
): { conversations: Conversation[]; found: boolean } {
  let found = false;
  const conversations = list.map(conversation => {
    if (conversation.id !== message.conversationId) return conversation;
    found = true;
    return {
      ...conversation,
      lastMessagePreview: message.content.slice(0, 100),
      lastMessageAt: message.createdAt,
    };
  });
  return { conversations: sortConversationsByRecent(conversations), found };
}
