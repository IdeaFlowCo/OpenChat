/**
 * Contact profile screen — opened by tapping the DM header avatar/name.
 * (OpenChat-???)
 *
 * Shows: large avatar, name + bot badge, email, status message, presence,
 * and quick actions (block, report). For non-bot users only — bots get a
 * simpler read-only view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { api, type User } from '../api/client';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import { usePrivateName } from '../contexts/PrivateNamesContext';
import { FriendControls } from '../components/FriendControls';
import { isPlaceholderEmail } from '../utils/email';
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
  const { userId, exactEmail } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser, conversations, presence, refreshConversations, createConversation } = useChat();

  // Pull the most recent user object from any conversation participant.
  // This stays fresh because ChatContext re-renders on participant updates.
  const conversationUser = useMemo(() => {
    for (const conv of conversations) {
      const p = conv.participants?.find((p) => p.user?.id === userId);
      if (p) return p.user;
    }
    return null;
  }, [conversations, userId]);

  const [profile, setProfile] = useState<{ id: string; user: User | null; unavailable: boolean } | null>(null);
  const isReadOnlyIdentity = conversationUser?.isBot || userId === currentUser?.userId;
  useEffect(() => {
    let active = true;
    setProfile(null);
    if (!isReadOnlyIdentity) {
      api.getContactProfile(userId, exactEmail).then(user => {
        if (active) setProfile({ id: userId, user, unavailable: false });
      }).catch(() => {
        if (active) setProfile({ id: userId, user: null, unavailable: true });
      });
    }
    return () => { active = false; };
  }, [userId, exactEmail, isReadOnlyIdentity, conversationUser?.name, conversationUser?.avatarUrl]);
  useEffect(() => { setEditingName(false); setNameDraft(''); setNameError(''); }, [userId]);
  const currentProfile = profile?.id === userId ? profile : null;
  const user = currentProfile?.unavailable ? null : currentProfile?.user ? { ...conversationUser, ...currentProfile.user } : conversationUser;
  const loadingProfile = !isReadOnlyIdentity && !currentProfile && !conversationUser;

  const canSetPrivateName = !!user && !user.isBot && userId !== currentUser?.userId;
  const privateName = usePrivateName(canSetPrivateName ? userId : undefined, exactEmail);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const saveName = async (name: string | null) => {
    setNameBusy(true);
    setNameError('');
    try {
      await privateName.save(name);
      setEditingName(false);
    } catch (error) {
      setNameError(error instanceof Error ? error.message : 'Could not save private name.');
    } finally { setNameBusy(false); }
  };
  const pres = presence.get(userId);

  const handleBlock = useCallback(() => {
    if (!user) return;
    const safeEmail = isPlaceholderEmail(user.email) ? '' : user.email;
    Alert.alert(
      `Block ${user.name || safeEmail || 'Unknown'}?`,
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
              navigation.goBack();
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
        {loadingProfile ? <ActivityIndicator color={c.primary} accessibilityLabel="Loading contact profile" /> : <Text style={{ color: c.textSecondary }}>Person unavailable.</Text>}
      </View>
    );
  }

  const safeEmail = isPlaceholderEmail(user.email) ? '' : user.email;
  const officialName = user.name || safeEmail || 'Unknown';
  const displayName = privateName.name || officialName;
  const presenceLine =
    (pres?.statusMessage) ||
    (pres?.status === 'online' ? 'Online' : null) ||
    (user.statusMessage) ||
    (user.lastSeenAt ? `Last seen ${relativeLastSeen(user.lastSeenAt)}` : '');

  return (
    <ScrollView style={[styles.root, { backgroundColor: c.background }]} contentContainerStyle={styles.content}>
      {/* Avatar + identity block */}
      <View style={styles.identity}>
        <Avatar name={displayName} email={safeEmail || undefined} isBot={user.isBot} avatarUrl={user.avatarUrl} size={108} />
        <View style={[styles.identityText]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Text style={[styles.name, { color: c.textPrimary }]} numberOfLines={1}>{displayName}</Text>
            <BotBadge isBot={user.isBot} />
          </View>
          {!!privateName.name && (
            <Text style={[styles.email, { color: c.textMetadata }]} accessibilityLabel={`Official OpenChat name: ${officialName}`}>
              OpenChat name: {officialName}
            </Text>
          )}
          {(user.profileStatus?.emoji || user.profileStatus?.text) && (
            <Text style={{ color: c.textPrimary, fontSize: 15, fontStyle: 'italic', marginTop: 4, textAlign: 'center', maxWidth: 280 }} numberOfLines={2}>
              {`${user.profileStatus.emoji ? user.profileStatus.emoji + ' ' : ''}${user.profileStatus.text || ''}`.trim()}
            </Text>
          )}
          {!!safeEmail && safeEmail !== displayName && (
            <Text style={[styles.email, { color: c.textSecondary }]} numberOfLines={1}>{safeEmail}</Text>

          )}
          {!!presenceLine && (
            <Text style={[styles.presence, { color: c.textSecondary }]}>{presenceLine}</Text>
          )}
        </View>
      </View>

      {canSetPrivateName && (
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, padding: 14, gap: 10 }]}>
          <Text style={{ color: c.textMetadata }}>Private name — visible only to you. Their OpenChat name is self-set.</Text>
          {editingName ? <>
            <TextInput
              accessibilityLabel="Private name"
              value={nameDraft}
              onChangeText={setNameDraft}
              maxLength={100}
              editable={!nameBusy}
              autoFocus
              style={{ color: c.textPrimary, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 12 }}
            />
            <TouchableOpacity style={styles.privateNameAction} accessibilityRole="button" disabled={nameBusy || !nameDraft.trim()} onPress={() => void saveName(nameDraft.trim())}>
              <Text style={{ color: c.primary }}>{nameBusy ? 'Saving…' : 'Save private name'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.privateNameAction} accessibilityRole="button" disabled={nameBusy} onPress={() => setEditingName(false)}>
              <Text style={{ color: c.textPrimary }}>Cancel</Text>
            </TouchableOpacity>
          </> : (
            <TouchableOpacity style={styles.privateNameAction} accessibilityRole="button" disabled={nameBusy} onPress={() => { setNameDraft(privateName.name || ''); setNameError(''); setEditingName(true); }}>
              <Text style={{ color: c.primary }}>{privateName.name ? 'Edit private name' : 'Set private name'}</Text>
            </TouchableOpacity>
          )}
          {!!privateName.name && <TouchableOpacity style={styles.privateNameAction} accessibilityRole="button" disabled={nameBusy} onPress={() => void saveName(null)}>
            <Text style={{ color: c.primary }}>Clear private name</Text>
          </TouchableOpacity>}
          {!!nameError && <Text accessibilityRole="alert" style={{ color: c.danger }}>{nameError}</Text>}
        </View>
      )}

      {!user.isBot && <FriendControls userId={userId} onMessage={async () => {
        const conversation = await createConversation([userId], { type: 'direct' });
        navigation.navigate('Chat', { conversationId: conversation.id });
      }} />}

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
  privateNameAction: { minHeight: 44, justifyContent: 'center' },
  rowLabel: { fontSize: 16, flex: 1 },
});
