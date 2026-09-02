import type { Conversation, CurrentUser, User } from '../api/client';

export const SELF_CONVERSATION_TITLE = 'Myself';

type ConversationLike = Pick<Conversation, 'type'> & {
  title?: string | null;
  participants?: Array<User | { user: User }>;
};

function participantUser(participant: User | { user: User }): User {
  return 'user' in participant ? participant.user : participant;
}

export function isSelfDirectConversation(
  conversation: ConversationLike,
  currentUser: CurrentUser | null
): boolean {
  const participants = conversation.participants ?? [];
  return conversation.type === 'direct'
    && !!currentUser
    && participants.length > 0
    && participants.every(participant => participantUser(participant).id === currentUser.userId);
}

export function getDirectConversationParticipant(
  conversation: ConversationLike,
  currentUser: CurrentUser | null
): User | undefined {
  const participants = conversation.participants ?? [];
  return participants.map(participantUser).find(user => user.id !== currentUser?.userId)
    ?? participants.map(participantUser).find(user => user.id === currentUser?.userId);
}

export function getDirectConversationTitle(
  conversation: ConversationLike,
  currentUser: CurrentUser | null,
  fallback: string
): string {
  if (isSelfDirectConversation(conversation, currentUser)) return SELF_CONVERSATION_TITLE;
  if (conversation.title) return conversation.title;
  const participant = getDirectConversationParticipant(conversation, currentUser);
  return participant?.name || participant?.email || fallback;
}
