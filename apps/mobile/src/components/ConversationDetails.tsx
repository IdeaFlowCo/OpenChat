/**
 * The Details tab of the conversation side panel: who this chat is with.
 *
 * A direct chat shows the person and your private layer about them; a group
 * shows its members. The full profile and group settings stay one press away
 * instead of being rebuilt here.
 */
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { usePrivateName } from '../contexts/PrivateNamesContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import type { NavProp } from '../navigation/types';
import { getDirectConversationParticipant, getUserDisplayName, isSelfDirectConversation } from '../utils/conversationDisplay';
import { AppIcon } from './AppIcon';
import { Avatar } from './Avatar';
import { PrivateCard } from './PrivateGraph';
import { Button, SectionLabel } from './ui';

export function ConversationDetails({ conversationId }: { conversationId: string }) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const navigation = useNavigation<NavProp<'Conversations'>>();
  const { conversations, currentUser, presence } = useChat();
  const conversation = useMemo(() => conversations.find(item => item.id === conversationId), [conversations, conversationId]);
  const isGroup = conversation?.type === 'group';
  const isSelf = conversation ? isSelfDirectConversation(conversation, currentUser) : false;
  const other = conversation && !isGroup ? getDirectConversationParticipant(conversation, currentUser) : null;
  const privateName = usePrivateName(!isGroup && !isSelf && !other?.isBot ? other?.id : undefined);

  if (!conversation) return null;

  if (isGroup) {
    const members = (conversation.participants || []).flatMap(participant => participant?.user?.id ? [participant.user] : []);
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <Avatar name={conversation.title || 'Group'} variant="group" groupMembers={members.filter(member => member.id !== currentUser?.userId)} size={56} />
          <Text style={[type.heading, styles.center, { color: r.text }]} numberOfLines={2}>{conversation.title || 'Group'}</Text>
          <Text style={[type.meta, { color: r.textMeta }]}>{members.length} {members.length === 1 ? 'member' : 'members'}</Text>
        </View>
        <View style={styles.actions}>
          <Button size="sm" label="Group info" icon="info" onPress={() => navigation.navigate('GroupSettings', { conversationId })} />
          <Button size="sm" label="Invite" icon="plus" onPress={() => navigation.navigate('GroupInvite', { conversationId })} />
        </View>
        <SectionLabel>Members</SectionLabel>
        <View style={[styles.list, { borderColor: r.line, backgroundColor: r.card }]}>
          {members.map((member, index) => {
            const me = member.id === currentUser?.userId;
            const status = presence.get(member.id)?.status;
            return (
              <TouchableOpacity
                key={member.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${getUserDisplayName(member)}`}
                disabled={me}
                onPress={() => navigation.navigate('ContactProfile', { userId: member.id })}
                style={[styles.member, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: r.line }]}
              >
                <Avatar name={getUserDisplayName(member)} avatarUrl={member.avatarUrl ?? undefined} isBot={member.isBot} size={28}
                  presenceStatus={status === 'available' ? status : undefined} />
                <Text style={[type.body, styles.memberName, { color: r.text }]} numberOfLines={1}>{getUserDisplayName(member)}{me ? ' (you)' : ''}</Text>
                {!me && <AppIcon name="chevron-right" color={r.decoration} size={16} />}
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  const name = privateName.name || (other ? getUserDisplayName(other) : isSelf ? 'Myself' : 'Chat');
  const status = other ? (presence.get(other.id)?.statusMessage || presence.get(other.id)?.status || other.presenceStatus || '') : '';
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.identity}>
        <Avatar name={other ? getUserDisplayName(other) : currentUser?.name} avatarUrl={(other?.avatarUrl ?? (isSelf ? currentUser?.avatarUrl : undefined)) ?? undefined} isBot={other?.isBot} size={56} />
        <Text style={[type.heading, styles.center, { color: r.text }]} numberOfLines={2}>{name}</Text>
        {privateName.name && other ? <Text style={[type.meta, { color: r.textMeta }]}>OpenChat name: {getUserDisplayName(other)}</Text> : null}
        {status ? <Text style={[type.meta, { color: r.textMeta }]} numberOfLines={2}>{status}</Text> : null}
        {isSelf ? <Text style={[type.meta, { color: r.textMeta }]}>Private notes to yourself</Text> : null}
      </View>
      {other && !isSelf && (
        <View style={styles.actions}>
          <Button size="sm" label="Profile" icon="info" onPress={() => navigation.navigate('ContactProfile', { userId: other.id })} />
        </View>
      )}
      {other && !other.isBot && !isSelf && (
        <PrivateCard
          userId={other.id}
          onOpenThing={thingId => navigation.navigate('PrivateThing', { thingId })}
          onOpenPerson={userId => navigation.navigate('ContactProfile', { userId })}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space[4], paddingBottom: space[8] },
  identity: { alignItems: 'center', gap: space[1], paddingTop: space[2], paddingBottom: space[3] },
  center: { textAlign: 'center', marginTop: space[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2] },
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  member: { minHeight: touchTarget, paddingHorizontal: space[3], flexDirection: 'row', alignItems: 'center', gap: space[3] },
  memberName: { flex: 1, minWidth: 0 },
});
