import type { Conversation, CurrentUser, Message } from '../api/client';
import { getUserDisplayName } from './conversationDisplay';

/** Sender labels are useful context in groups, but redundant in direct chats. */
export function shouldShowGroupSenderLabel(
  isGroup: boolean,
  isOwn: boolean,
  senderId: string,
  previousSenderId?: string,
): boolean {
  return isGroup && !isOwn && senderId !== previousSenderId;
}

/** Conversation-list copy, including a sender prefix only for group chats. */
export function getConversationPreview(
  conversation: Conversation,
  currentUser: CurrentUser | null,
): string {
  const preview = conversation.lastMessagePreview;
  if (!preview) return conversation.type === 'group' ? 'Group conversation' : '';
  if (conversation.type !== 'group') return preview;

  const senderId = conversation.lastMessage?.senderId;
  if (!senderId) return preview;
  if (senderId === currentUser?.userId) return `You: ${preview}`;

  const sender = conversation.participants
    ?.find(participant => participant?.user?.id === senderId)
    ?.user;
  return `${getUserDisplayName(sender)}: ${preview}`;
}

/** Keep the list's latest-message metadata current between REST refreshes. */
export function conversationLastMessage(message: Message): Pick<Conversation, 'lastMessageAt' | 'lastMessagePreview' | 'lastMessage'> {
  return {
    lastMessagePreview: message.content.slice(0, 100),
    lastMessageAt: message.createdAt,
    lastMessage: message,
  };
}
