import type { Conversation, CurrentUser, User } from '../api/client';

export const SELF_CONVERSATION_TITLE = 'Myself';

export function isSelfDirectConversation(
  conversation: Conversation,
  currentUser: CurrentUser | null
): boolean {
  const participants = conversation.participants ?? [];
  return conversation.type === 'direct'
    && !!currentUser
    && participants.length > 0
    && participants.every(participant => participant.user.id === currentUser.userId);
}

export function getDirectConversationParticipant(
  conversation: Conversation,
  currentUser: CurrentUser | null
): User | undefined {
  const participants = conversation.participants ?? [];
  return participants.find(participant => participant.user.id !== currentUser?.userId)?.user
    ?? participants.find(participant => participant.user.id === currentUser?.userId)?.user;
}

export function getDirectConversationTitle(
  conversation: Conversation,
  currentUser: CurrentUser | null,
  fallback: string
): string {
  if (conversation.title) return conversation.title;
  if (isSelfDirectConversation(conversation, currentUser)) return SELF_CONVERSATION_TITLE;
  const participant = getDirectConversationParticipant(conversation, currentUser);
  return participant?.name || participant?.email || fallback;
}
