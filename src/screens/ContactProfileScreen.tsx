/**
 * Contact profile screen — opened by tapping the DM header avatar/name.
 * (OpenChat-???)
 *
 * Shows: large avatar, name + bot badge, email, status message, presence,
 * and quick actions (block, report). For non-bot users only — bots get a
 * simpler read-only view.
 */

import { useCallback, useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { api } from '../api/client';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import type { NavProp, RouteProps } from '../navigation/types';

function relativeLastSeen(iso: string | undefined): string {
  if (!iso) return '';
  const last = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - last);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export function ContactProfileScreen() {
  const navigation = useNavigation<NavProp<'ContactProfile'>>();
  const route = useRoute<RouteProps<'ContactProfile'>>();
  const { userId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { conversations, presence, refreshConversations } = useChat();

  // Pull the most recent user object from any conversation participant.
  // This stays fresh because ChatContext re-renders on participant updates.
  const user = useMemo(() => {
    for (const conv of conversations) {
      const p = conv.participants?.find((p) => p.user.id === userId);
      if (p) return p.user;
    }
    return null;
  }, [conversations, userId]);

  const pres = presence.get(userId);

  const handleBlock = useCallback(() => {
    if (!user) return;
    Alert.alert(
      `Block ${user.name || user.email}?`,
      "You won't receive messages from them anymore. You can unblock from Settings.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.blockUser(user.id);
              await refreshConversations();
              navigation.goBack(); // back to Chat
              navigation.goBack(); // back to Conversations list
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to block.');
            }
          },
        },
      ],
    );
  }, [user, refreshConversations, navigation]);

  const handleReport = useCallback(() => {
    if (!user) return;
    Alert.alert('Report user?', 'Pick a reason in the next prompt.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Continue',
        onPress: () => {
          Alert.alert('Reason', undefined, [
            { text: 'Spam', onPress: () => submitReport('spam') },
            { text: 'Inappropriate', onPress: () => submitReport('inappropriate') },
            { text: 'Abuse', onPress: () => submitReport('abuse') },
            { text: 'Other', onPress: () => submitReport('other') },
            { text: 'Cancel', style: 'cancel' },
          ]);
        },
      },
    ]);
  }, [user]);

  const submitReport = useCallback(async (reason: string) => {
    if (!user) return;
    try {
      await api.submitReport({ targetType: 'user', targetId: user.id, reason });
      Alert.alert("Thanks — we've received your report.");
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to submit report.');
    }
  }, [user]);

  if (!user) {
    return (
      <View style={[styles.root, { backgroundColor: c.background, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: c.textSecondary }}>Contact not found.</Text>
      </View>
    );
  }

  const displayName = user.name || user.email || 'Unknown';
  const presenceLine =
    (pres?.statusMessage) ||
    (pres?.status === 'online' ? 'Online' : null) ||
    (user.statusMessage) ||
    (user.lastSeenAt ? `Last seen ${relativeLastSeen(user.lastSeenAt)}` : '');

  return (
    <ScrollView style={[styles.root, { backgroundColor: c.background }]} contentContainerStyle={styles.content}>
      {/* Avatar + identity block */}
      <View style={styles.identity}>
        <Avatar name={displayName} email={user.email} isBot={user.isBot} size={108} />
        <View style={[styles.identityText]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Text style={[styles.name, { color: c.textPrimary }]} numberOfLines={1}>{displayName}</Text>
            <BotBadge isBot={user.isBot} />
          </View>
          {!!user.email && user.email !== displayName && (
            <Text style={[styles.email, { color: c.textSecondary }]} numberOfLines={1}>{user.email}</Text>
          )}
          {!!presenceLine && (
            <Text style={[styles.presence, { color: c.textSecondary }]}>{presenceLine}</Text>
          )}
        </View>
      </View>

      {/* Actions */}
      {!user.isBot && (
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={handleReport}
            activeOpacity={0.7}
          >
            <Text style={[styles.rowLabel, { color: c.textPrimary }]}>Report user</Text>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.row} onPress={handleBlock} activeOpacity={0.7}>
            <Text style={[styles.rowLabel, { color: c.danger }]}>Block user</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, alignItems: 'stretch' },
  identity: { alignItems: 'center', paddingVertical: 24, gap: 12 },
  identityText: { alignItems: 'center', gap: 4 },
  name: { fontSize: 22, fontWeight: '700', maxWidth: 280, textAlign: 'center' },
  email: { fontSize: 14 },
  presence: { fontSize: 13, marginTop: 2 },
  card: {
    marginTop: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 16, flex: 1 },
});
