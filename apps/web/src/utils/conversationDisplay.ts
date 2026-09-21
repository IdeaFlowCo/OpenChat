import type { Conversation, User } from '../api';
import type { CurrentUserLike } from './userDisplay';

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
  currentUser: CurrentUserLike | null | undefined
): boolean {
  const participants = conversation.participants ?? [];
  return conversation.type === 'direct'
    && !!currentUser
    && participants.length > 0
    && participants.every(participant => participantUser(participant).id === currentUser.userId);
}

export function getDirectConversationParticipant(
  conversation: ConversationLike,
  currentUser: CurrentUserLike | null | undefined
): User | undefined {
  const participants = conversation.participants ?? [];
  return participants.map(participantUser).find(user => user.id !== currentUser?.userId)
    ?? participants.map(participantUser).find(user => user.id === currentUser?.userId);
}

export function getDirectConversationTitle(
  conversation: ConversationLike,
  currentUser: CurrentUserLike | null | undefined,
  fallback: string
): string {
  if (isSelfDirectConversation(conversation, currentUser)) return SELF_CONVERSATION_TITLE;
  if (conversation.title) return conversation.title;
  const participant = getDirectConversationParticipant(conversation, currentUser);
  return participant?.name || participant?.email || fallback;
}

export function getConversationPreview(
  conversation: Conversation,
  currentUser: CurrentUserLike | null | undefined,
): string {
  const preview = conversation.lastMessagePreview ?? '';
  if (!preview || conversation.type !== 'group') return preview;

  const senderId = conversation.lastMessage?.senderId;
  if (!senderId) return preview;
  if (senderId === currentUser?.userId) return `You: ${preview}`;

  const sender = conversation.participants
    ?.map(participantUser)
    .find(user => user.id === senderId);
  const name = sender?.name || sender?.email?.split('@')[0] || 'OpenChat member';
  return `${name}: ${preview}`;
}
