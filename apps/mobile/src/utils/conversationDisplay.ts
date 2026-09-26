import type { Conversation, CurrentUser, User } from '../api/client';
import { isPlaceholderEmail } from './email';

export const SELF_CONVERSATION_TITLE = 'Myself';
export const AGENT_DISPLAY_NAME = 'OpenChat Agent';

export function getUserDisplayName(user?: Pick<User, 'name' | 'email'> | null): string {
  const safeEmail = isPlaceholderEmail(user?.email) ? undefined : user?.email;
  return user?.name || safeEmail?.split('@')[0] || 'OpenChat member';
}

type ConversationLike = Pick<Conversation, 'type'> & {
  title?: string | null;
  participants?: Array<User | { user?: User | null } | null>;
};

function participantUser(participant: User | { user?: User | null } | null): User | undefined {
  if (!participant) return undefined;
  return 'id' in participant ? participant : participant.user ?? undefined;
}

export function isSelfDirectConversation(
  conversation: ConversationLike,
  currentUser: CurrentUser | null
): boolean {
  const participants = conversation.participants ?? [];
  return conversation.type === 'direct'
    && !!currentUser
    && participants.length > 0
    && participants.every(participant => participantUser(participant)?.id === currentUser.userId);
}

export function getDirectConversationParticipant(
  conversation: ConversationLike,
  currentUser: CurrentUser | null
): User | undefined {
  const participants = conversation.participants ?? [];
  const users = participants.map(participantUser).filter((user): user is User => !!user?.id);
  return users.find(user => user.id !== currentUser?.userId)
    ?? users.find(user => user.id === currentUser?.userId);
}

export function getDirectConversationTitle(
  conversation: ConversationLike,
  currentUser: CurrentUser | null,
  fallback: string
): string {
  if (isSelfDirectConversation(conversation, currentUser)) return SELF_CONVERSATION_TITLE;
  if (conversation.title) return conversation.title;
  const participant = getDirectConversationParticipant(conversation, currentUser);
  if (participant?.isBot && (participant.id === 'assistant' || participant.name === 'Assistant')) {
    return AGENT_DISPLAY_NAME;
  }
  const safeEmail = isPlaceholderEmail(participant?.email) ? undefined : participant?.email;
  return participant?.name || safeEmail || fallback;
}
