/**
 * A cached conversation participant must not keep a person's profile visible
 * after the authenticated official-profile lookup denies access. The lookup
 * also supports people with no conversation; it does not create a DM.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { api, type User } from '../api/client';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import { usePrivateName } from '../contexts/PrivateNamesContext';
import { PrivateCard } from '../components/PrivateGraph';
import { ProfileActions } from '../components/ProfileActions';
import { ProfileAsks } from '../components/ProfileAsks';
import { Button, Card, ListRow, SectionLabel } from '../components/ui';
import { radius, roles, space, type } from '../theme/tokens';
import { confirmAction } from '../utils/confirm';
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
  const r = roles(c);
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

  const groupsInCommon = useMemo(
    () => conversations.filter(conv => conv.type === 'group' && conv.participants?.some(p => p.user?.id === userId)).length,
    [conversations, userId],
  );

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
    confirmAction(
      `Block ${user.name || safeEmail || 'Unknown'}?`,
      "You won't receive messages from them anymore. You can unblock from Settings.",
      'Block',
      () => void (async () => {
        try {
          await api.blockUser(user.id);
          await refreshConversations();
          navigation.goBack();
        } catch (err) {
          Alert.alert('Error', err instanceof Error ? err.message : 'Failed to block.');
        }
      })(),
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
      <View style={[styles.root, styles.centered, { backgroundColor: r.canvas }]}>
        {loadingProfile ? <ActivityIndicator color={r.accent} accessibilityLabel="Loading contact profile" /> : <Text style={[type.body, { color: r.textSecondary }]}>Person unavailable.</Text>}
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
  const isSelf = userId === currentUser?.userId;
  const statusText = `${user.profileStatus?.emoji ? user.profileStatus.emoji + ' ' : ''}${user.profileStatus?.text || ''}`.trim();
  const card = user.card;
  const links = [
    card?.linkedIn ? { label: 'LinkedIn', url: card.linkedIn } : null,
    card?.x ? { label: 'X', url: card.x } : null,
    card?.link ? { label: 'Website', url: card.link } : null,
  ].filter((link): link is { label: string; url: string } => !!link);
  const meta = [presenceLine, !user.isBot && groupsInCommon > 0 ? `${groupsInCommon} ${groupsInCommon === 1 ? 'group' : 'groups'} in common` : ''].filter(Boolean).join(' · ');

  const nameRow = canSetPrivateName ? (editingName ? (
    <View style={styles.nameEditor}>
      <TextInput
        accessibilityLabel="Private name"
        value={nameDraft}
        onChangeText={setNameDraft}
        maxLength={100}
        editable={!nameBusy}
        autoFocus
        placeholder={officialName}
        placeholderTextColor={r.decoration}
        style={[styles.input, { color: r.text, backgroundColor: r.input, borderColor: r.line }]}
      />
      <View style={styles.inlineButtons}>
        <Button size="sm" variant="primary" label={nameBusy ? 'Saving…' : 'Save private name'} disabled={nameBusy || !nameDraft.trim()} onPress={() => void saveName(nameDraft.trim())} />
        <Button size="sm" variant="ghost" label="Cancel" disabled={nameBusy} onPress={() => setEditingName(false)} />
        {!!privateName.name && <Button size="sm" variant="ghost" label="Clear private name" disabled={nameBusy} onPress={() => void saveName(null)} />}
      </View>
      {!!nameError && <Text accessibilityRole="alert" style={[type.meta, { color: r.danger }]}>{nameError}</Text>}
    </View>
  ) : (
    <ListRow
      icon="edit"
      title={privateName.name ? 'Edit private name' : 'Set private name'}
      subtitle={privateName.name ? `Shown to you instead of ${officialName}` : 'A name only you see'}
      disabled={nameBusy}
      onPress={() => { setNameDraft(privateName.name || ''); setNameError(''); setEditingName(true); }}
      style={styles.flushRow}
    />
  )) : null;

  return (
    <ScrollView style={[styles.root, { backgroundColor: r.canvas }]} contentContainerStyle={styles.content}>
      {/* Their layer: identity, then what they chose to show. */}
      <View style={styles.identity}>
        <Avatar name={displayName} email={safeEmail || undefined} isBot={user.isBot} avatarUrl={user.avatarUrl} size={88} />
        <View style={styles.identityText}>
          <View style={styles.nameRow}>
            <Text style={[type.heading, styles.name, { color: r.text }]} numberOfLines={1}>{displayName}</Text>
            <BotBadge isBot={user.isBot} />
          </View>
          {!!privateName.name && (
            <Text style={[type.meta, { color: r.textMeta }]} accessibilityLabel={`Official OpenChat name: ${officialName}`}>
              OpenChat name: {officialName}
            </Text>
          )}
          {!!card?.headline && <Text style={[type.body, styles.centeredText, { color: r.textSecondary }]} numberOfLines={2}>{card.headline}</Text>}
          {!!statusText && <Text style={[type.body, styles.centeredText, { color: r.text }]} numberOfLines={2}>{statusText}</Text>}
          {!!safeEmail && safeEmail !== displayName && (
            <Text style={[type.label, { color: r.textSecondary }]} numberOfLines={1}>{safeEmail}</Text>
          )}
          {!!meta && <Text style={[type.meta, { color: r.textMeta }]}>{meta}</Text>}
        </View>
      </View>

      {!isSelf && (
        <ProfileActions
          userId={userId}
          name={displayName}
          isBot={user.isBot}
          onMessage={async () => {
            const conversation = await createConversation([userId], { type: 'direct' });
            navigation.navigate('Chat', { conversationId: conversation.id });
          }}
          onAskAgent={canSetPrivateName ? () => navigation.navigate('AgentOverlay', { context: { kind: 'person', id: userId, label: displayName, includePrivate: true } }) : undefined}
        />
      )}

      {links.length > 0 && (
        <>
          <SectionLabel>Links</SectionLabel>
          <Card padding="none">
            {links.map((link, index) => (
              <ListRow
                key={link.label}
                icon="link"
                title={link.label}
                subtitle={link.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}
                divider={index > 0}
                chevron={false}
                onPress={() => void Linking.openURL(link.url)}
                accessibilityLabel={`${link.label}: ${link.url}`}
              />
            ))}
          </Card>
        </>
      )}

      {/* What they are asking for, limited to what they shared with you. */}
      {canSetPrivateName && <ProfileAsks userId={userId} onOpenStory={story => navigation.navigate('StoryViewer', { story })} />}

      {/* Your layer: notes, importance, catch-up, links and the private name. Collapsed until opened. */}
      {canSetPrivateName && (
        <PrivateCard
          userId={userId}
          nameRow={nameRow}
          onOpenThing={thingId => navigation.navigate('PrivateThing', { thingId })}
          onOpenPerson={id => navigation.push('ContactProfile', { userId: id })}
        />
      )}

      {!user.isBot && !isSelf && (
        <Card padding="none" style={styles.safety}>
          <ListRow icon="flag" title="Report user" onPress={handleReport} />
          <ListRow icon="block" title="Block user" destructive divider chevron={false} onPress={handleBlock} />
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  content: { padding: space[4], paddingBottom: space[10], alignItems: 'stretch', width: '100%', maxWidth: 720, alignSelf: 'center' },
  identity: { alignItems: 'center', paddingTop: space[4], gap: space[3] },
  identityText: { alignItems: 'center', gap: space[1] },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space[2] },
  name: { maxWidth: 300, textAlign: 'center' },
  centeredText: { textAlign: 'center', maxWidth: 320 },
  nameEditor: { gap: space[2], paddingVertical: space[2] },
  input: { ...type.body, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[3], minHeight: 44 },
  inlineButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  flushRow: { paddingHorizontal: 0 },
  safety: { marginTop: space[6] },
});
