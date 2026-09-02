/**
 * ChatEmptyState — shown in ChatScreen when there are no messages yet
 * (OpenChat-0kl). Renders only when messages.length === 0 && !loadingMessages.
 *
 * DM:    "This is the start of your chat with {name}"
 * Group: "This is a new group with N people"
 */

import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from './Avatar';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { Conversation, CurrentUser } from '../api/client';
import {
  getDirectConversationParticipant,
  isSelfDirectConversation,
} from '../utils/conversationDisplay';

interface Props {
  conversation: Conversation | undefined;
  currentUser: CurrentUser | null;
}

export function ChatEmptyState({ conversation, currentUser }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  if (!conversation) return null;

  const isGroup = conversation.type === 'group';
  const isSelfDM = isSelfDirectConversation(conversation, currentUser);
  const other = !isGroup
    ? getDirectConversationParticipant(conversation, currentUser)
    : null;

  const avatarName = isGroup
    ? (conversation.title ||
        (conversation.participants || [])
          .filter(p => p.user.id !== currentUser?.userId)
          .map(p => p.user.name || p.user.email?.split('@')[0] || '?')
          .slice(0, 2)
          .join(', '))
    : (other?.name || other?.email);

  const label = isGroup
    ? `This is a new group with ${conversation.participants?.length ?? 0} people`
    : isSelfDM
      ? 'Messages here are just for you'
      : `This is the start of your chat with ${other?.name || other?.email || 'someone'}`;

  return (
    <View style={styles.wrap}>
      <Avatar
        name={avatarName}
        email={other?.email}
        isBot={!isGroup ? other?.isBot : false}
        size={64}
      />
      <Text style={[styles.label, { color: c.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 32,
    gap: 12,
  },
  label: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
