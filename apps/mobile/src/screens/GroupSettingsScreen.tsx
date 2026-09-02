/**
 * Group settings — rename, view members, add a member, remove members (owner
 * only), and Leave. Mirrors web GroupSettings.tsx.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, User } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import type { NavProp, RouteProps } from '../navigation/types';

export function GroupSettingsScreen() {
  const navigation = useNavigation<NavProp<'GroupSettings'>>();
  const route = useRoute<RouteProps<'GroupSettings'>>();
  const { conversationId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const {
    conversations,
    currentUser,
    presence,
    renameConversation,
    addParticipant,
    removeParticipant,
    setActiveConversation,
  } = useChat();

  const conversation = useMemo(
    () => conversations.find(cv => cv.id === conversationId),
    [conversations, conversationId]
  );

  const meParticipant = conversation?.participants?.find(p => p.user.id === currentUser?.userId);
  const isOwner = meParticipant?.role === 'owner';
  const memberIds = new Set((conversation?.participants || []).map(p => p.user.id));

  const [draftTitle, setDraftTitle] = useState(conversation?.title || '');
  const [savingTitle, setSavingTitle] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<User[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    setDraftTitle(conversation?.title || '');
  }, [conversation?.title]);

  useEffect(() => {
    if (!showAdd) return;
    let cancelled = false;
    api.getContacts(addQuery || undefined)
      .then(rows => {
        if (!cancelled) setAddResults(rows.filter(u => !memberIds.has(u.id)));
      })
      .catch(err => console.warn('[GroupSettings] contact search failed:', err));
    return () => { cancelled = true; };
  }, [addQuery, showAdd, conversation?.participants]);

  if (!conversation) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Text style={{ color: c.textSecondary, padding: 16 }}>Conversation not found.</Text>
      </View>
    );
  }

  const saveTitle = async () => {
    if (!isOwner) return;
    const trimmed = draftTitle.trim();
    if (trimmed === (conversation.title || '')) return;
    setSavingTitle(true);
    try {
      await renameConversation(conversationId, trimmed);
      // Light-touch success feedback: the title in the header + chat list
      // updates via the conversation:updated socket event, but the user is on
      // this screen, so confirm explicitly so they know the save landed.
      Alert.alert('Group renamed', `Now called "${trimmed || 'Group'}".`);
    } catch (err) {
      Alert.alert('Rename failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTitle(false);
    }
  };

  // True when the input differs from the persisted title — drives the Save button.
  const titleDirty = draftTitle.trim() !== (conversation.title || '').trim();

  const onAdd = async (u: User) => {
    setAdding(u.id);
    try {
      await addParticipant(conversationId, u.id);
      setAddQuery('');
    } catch (err) {
      Alert.alert('Could not add', err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(null);
    }
  };

  const onRemove = (target: User) => {
    Alert.alert(
      `Remove ${target.name || target.email}?`,
      'They will lose access to this conversation.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemoving(target.id);
            try { await removeParticipant(conversationId, target.id); }
            catch (err) { Alert.alert('Remove failed', err instanceof Error ? err.message : String(err)); }
            finally { setRemoving(null); }
          },
        },
      ]
    );
  };

  const onLeave = () => {
    if (!currentUser) return;
    const youAreOwnerWithOthers = isOwner && (conversation.participants?.length || 0) > 1;
    if (youAreOwnerWithOthers) {
      Alert.alert(
        'Cannot leave',
        'You are the owner of this group. Remove all other members first, or transfer ownership.'
      );
      return;
    }
    Alert.alert(
      'Leave group?',
      'You will lose access to this conversation.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeParticipant(conversationId, currentUser.userId);
              setActiveConversation(null);
              navigation.popToTop();
            } catch (err) {
              Alert.alert('Leave failed', err instanceof Error ? err.message : String(err));
            }
          },
        },
      ]
    );
  };

  const participants = conversation.participants || [];

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <FlatList
        data={participants}
        keyExtractor={p => p.user.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Text style={[styles.section, { color: c.textSecondary }]}>GROUP NAME</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, {
                  backgroundColor: c.surfaceElevated,
                  color: c.textPrimary,
                  borderColor: c.border,
                  flex: 1,
                  opacity: isOwner ? 1 : 0.6,
                }]}
                value={draftTitle}
                onChangeText={setDraftTitle}
                editable={isOwner}
                placeholder="Group name (optional)"
                placeholderTextColor={c.textMuted}
                onSubmitEditing={saveTitle}
                returnKeyType="done"
              />
              {savingTitle && <ActivityIndicator color={c.primary} style={{ marginLeft: 8 }} />}
            </View>
            {isOwner && (
              <TouchableOpacity
                onPress={saveTitle}
                disabled={!titleDirty || savingTitle}
                style={[
                  styles.saveBtn,
                  {
                    backgroundColor: titleDirty && !savingTitle ? c.primary : c.surfaceElevated,
                    borderColor: c.border,
                    opacity: titleDirty && !savingTitle ? 1 : 0.5,
                  },
                ]}
              >
                <Text style={{
                  color: titleDirty && !savingTitle ? '#fff' : c.textSecondary,
                  fontWeight: '600',
                }}>
                  {savingTitle ? 'Saving…' : 'Save name'}
                </Text>
              </TouchableOpacity>
            )}
            {!isOwner && (
              <Text style={[styles.hint, { color: c.textMuted }]}>Only the owner can rename the group.</Text>
            )}
            <Text style={[styles.section, { color: c.textSecondary, marginTop: 24 }]}>
              MEMBERS · {participants.length}
            </Text>
          </View>
        }
        renderItem={({ item: p }) => {
          const isMe = p.user.id === currentUser?.userId;
          const live = presence.get(p.user.id);
          const canRemove = isOwner && !isMe;
          return (
            <View style={[styles.memberRow, { borderColor: c.divider }]}>
              <Avatar
                name={p.user.name}
                email={p.user.email}
                isBot={p.user.isBot}
                presenceStatus={live?.status || p.user.presenceStatus}
                size={40}
              />
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={[styles.memberName, { color: c.textPrimary }]} numberOfLines={1}>
                    {p.user.name || p.user.email}
                    {isMe && <Text style={{ color: c.textMuted, fontWeight: '400' }}>  (you)</Text>}
                  </Text>
                  <BotBadge isBot={p.user.isBot} compact />
                </View>
                <Text style={[styles.memberEmail, { color: c.textSecondary }]} numberOfLines={1}>
                  {p.user.email}{p.role === 'owner' ? '  · owner' : ''}
                </Text>
              </View>
              {canRemove && (
                <TouchableOpacity
                  onPress={() => onRemove(p.user)}
                  disabled={removing === p.user.id}
                  style={{ padding: 6 }}
                >
                  <Text style={{ color: c.danger, fontWeight: '600', opacity: removing === p.user.id ? 0.4 : 1 }}>
                    Remove
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
        ListFooterComponent={
          <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}>
            {isOwner && (
              <>
                <TouchableOpacity
                  style={[styles.addBtn, { borderColor: c.border, backgroundColor: c.surfaceElevated }]}
                  onPress={() => navigation.navigate('GroupInvite', { conversationId })}
                >
                  <Text style={{ color: c.primary, fontWeight: '600' }}>
                    Invite via QR / link
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.addBtn, { borderColor: c.border, backgroundColor: c.surfaceElevated, marginTop: 8 }]}
                  onPress={() => setShowAdd(v => !v)}
                >
                  <Text style={{ color: c.primary, fontWeight: '600' }}>
                    {showAdd ? 'Done adding' : '+ Add people'}
                  </Text>
                </TouchableOpacity>
                {showAdd && (
                  <View style={{ marginTop: 12 }}>
                    <TextInput
                      style={[styles.input, {
                        backgroundColor: c.surfaceElevated,
                        color: c.textPrimary,
                        borderColor: c.border,
                      }]}
                      value={addQuery}
                      onChangeText={setAddQuery}
                      placeholder={currentUser?.canBrowseUserDirectory ? 'Search by name or email' : 'Enter a complete email address'}
                      placeholderTextColor={c.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 6 }}>
                      {currentUser?.canBrowseUserDirectory
                        ? 'Trusted directory access is enabled, or use the private QR / invite link above.'
                        : 'Exact email only, or use the private QR / invite link above.'}
                    </Text>
                    {addResults.slice(0, 10).map(u => (
                      <TouchableOpacity
                        key={u.id}
                        style={[styles.memberRow, { borderColor: c.divider, marginHorizontal: 0 }]}
                        onPress={() => onAdd(u)}
                        disabled={adding === u.id}
                      >
                        <Avatar name={u.name} email={u.email} isBot={u.isBot} size={36} />
                        <View style={{ flex: 1 }}>
                          <View style={styles.rowTop}>
                            <Text style={[styles.memberName, { color: c.textPrimary }]} numberOfLines={1}>
                              {u.name || u.email}
                            </Text>
                            <BotBadge isBot={u.isBot} compact />
                          </View>
                          <Text style={[styles.memberEmail, { color: c.textSecondary }]} numberOfLines={1}>
                            {u.email}
                          </Text>
                        </View>
                        <Text style={{ color: c.primary, fontWeight: '600', opacity: adding === u.id ? 0.4 : 1 }}>
                          {adding === u.id ? 'Adding…' : 'Add'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </>
            )}
            <TouchableOpacity
              style={[styles.leaveBtn, { borderColor: c.danger }]}
              onPress={onLeave}
            >
              <Text style={{ color: c.danger, fontWeight: '600' }}>Leave group</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  section: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  hint: { fontSize: 12, marginTop: 4 },
  saveBtn: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberName: { fontSize: 16, fontWeight: '600' },
  memberEmail: { fontSize: 13, marginTop: 2 },
  addBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    marginTop: 16,
  },
  leaveBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    marginTop: 24,
  },
});
