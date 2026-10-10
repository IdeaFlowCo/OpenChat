/**
 * Compose / new-conversation flow (OpenChat-eo3n.2).
 *
 * Like WhatsApp, Telegram and Messenger: a search field, one "New group" row,
 * then people in three tiers: Recent (your direct chats, newest first),
 * Friends, and Everyone (the directory search). Recent and Friends come from
 * data already loaded, so they show and filter instantly. Tapping a person
 * starts the DM; in New group, tapping selects. Inviting and scanning are
 * contact management: they live on People and in the no-results state.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { useNavigation } from '@react-navigation/native';
import { api, User } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import { YouBadge } from '../components/YouBadge';
import { AppIcon } from '../components/AppIcon';
import { Button, Chip, ListRow, SectionLabel } from '../components/ui';
import { radius, roles, space, type } from '../theme/tokens';
import { buildComposeSections } from '../utils/composeSections';
import { AGENT_DISPLAY_NAME, getUserDisplayName } from '../utils/conversationDisplay';
import { isPlaceholderEmail } from '../utils/email';
import type { NavProp } from '../navigation/types';

type Mode = 'direct' | 'group';
const DIRECTORY_PAGE_SIZE = 50;

function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function NewConversationScreen() {
  const navigation = useNavigation<NavProp<'NewConversation'>>();
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const { createConversation, currentUser, presence, conversations } = useChat();
  const [friendUsers, setFriendUsers] = useState<User[]>([]);
  const [blockedIds, setBlockedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let active = true;
    api.listFriends()
      .then(lists => { if (active) setFriendUsers(lists.friends.map(row => ({ id: row.user?.id ?? row.userId, name: row.user?.name, avatarUrl: row.user?.avatarUrl }))); })
      .catch(() => { /* Friends is additive; the directory still works. */ });
    api.listBlocked()
      .then(users => { if (active) setBlockedIds(new Set(users.map(user => user.id))); })
      .catch(() => { /* Best effort: the server still refuses blocked people. */ });
    return () => { active = false; };
  }, []);

  const [mode, setMode] = useState<Mode>('direct');
  const [query, setQuery] = useState('');
  const [contactResult, setContactResult] = useState<{ rows: User[]; query: string }>({ rows: [], query: '' });
  const results = contactResult.rows;
  const resultQuery = contactResult.query.trim();
  const exactEmail = resultQuery.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resultQuery) ? resultQuery : undefined;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<User[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const trimmedGroupTitle = groupTitle.trim();
  const canCreateGroup = selected.length > 0 || trimmedGroupTitle.length > 0;

  const debounced = useDebounced(query, 300);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getContacts(debounced || undefined, { limit: DIRECTORY_PAGE_SIZE, offset: 0 })
      .then(rows => {
        if (cancelled) return;
        setContactResult({ rows, query: debounced });
        setHasMore(
          debounced.trim().length === 0
            && currentUser?.openUserDirectoryEnabled === true
            && rows.length === DIRECTORY_PAGE_SIZE,
        );
      })
      .catch(err => {
        console.warn('[NewConversation] search failed:', err);
        if (!cancelled) {
          setContactResult({ rows: [], query: debounced });
          setHasMore(false);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [debounced, currentUser?.openUserDirectoryEnabled]);

  const loadMore = () => {
    if (
      debounced.trim().length > 0
      || contactResult.query.trim().length > 0
      || currentUser?.openUserDirectoryEnabled !== true
      || loading
      || loadingMore
      || !hasMore
    ) return;

    setLoadingMore(true);
    api.getContacts(undefined, { limit: DIRECTORY_PAGE_SIZE, offset: results.length })
      .then(rows => {
        setContactResult(previous => {
          if (previous !== contactResult) return previous;
          const known = new Set(previous.rows.map(user => user.id));
          return { ...previous, rows: [...previous.rows, ...rows.filter(user => !known.has(user.id))] };
        });
        setHasMore(rows.length === DIRECTORY_PAGE_SIZE);
      })
      .catch(err => {
        console.warn('[NewConversation] directory page failed:', err);
        setHasMore(false);
      })
      .finally(() => setLoadingMore(false));
  };

  const isSelected = (id: string) => selected.some(u => u.id === id);

  const handleSelect = async (user: User) => {
    if (mode === 'direct') {
      if (creating) return;
      setCreating(true);
      try {
        const conv = await createConversation([user.id], { type: 'direct' });
        navigation.replace('Chat', { conversationId: conv.id });
      } catch (err) {
        Alert.alert('Could not start chat', err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    } else {
      // group: toggle selection
      setSelected(prev => isSelected(user.id) ? prev.filter(u => u.id !== user.id) : [...prev, user]);
    }
  };

  const handleCreateGroup = async () => {
    if (!canCreateGroup || creating) return;
    setCreating(true);
    try {
      const conv = await createConversation(
        selected.map(u => u.id),
        { type: 'group', title: trimmedGroupTitle || undefined }
      );
      navigation.replace('Chat', { conversationId: conv.id });
    } catch (err) {
      Alert.alert('Could not create group', err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const sections = useMemo(() => buildComposeSections({
    conversations, friends: friendUsers, directory: results, currentUserId: currentUser?.userId, query, blockedIds,
  }), [conversations, friendUsers, results, currentUser?.userId, query, blockedIds]);
  const friendIds = useMemo(() => new Set(friendUsers.map(user => user.id)), [friendUsers]);

  type Tier = 'recent' | 'friends' | 'everyone';
  type Item = { kind: 'header'; key: string; title: string } | { kind: 'person'; key: string; user: User; tier: Tier };
  const items = useMemo(() => {
    const out: Item[] = [];
    const add = (tier: Tier, title: string, users: User[]) => {
      if (!users.length) return;
      out.push({ kind: 'header', key: `h-${tier}`, title });
      for (const user of users) out.push({ kind: 'person', key: `${tier}-${user.id}`, user, tier });
    };
    add('recent', 'Recent', sections.recent);
    add('friends', 'Friends', sections.friends);
    add('everyone', 'Everyone', sections.everyone);
    return out;
  }, [sections]);
  // Pending until the directory has answered for exactly this query, so the
  // no-results state never flashes between keystroke and request.
  const searching = loading || contactResult.query !== query;
  const trimmedQuery = query.trim();

  const leaveGroup = () => { setMode('direct'); setSelected([]); setGroupTitle(''); };

  const renderPerson = (item: User, tier: Tier) => {
    const checked = isSelected(item.id);
    const live = presence.get(item.id);
    const isSelf = item.id === currentUser?.userId;
    const name = isSelf ? (item.name || currentUser?.name || 'You')
      : item.isBot && (item.id === 'assistant' || item.name === 'Assistant') ? AGENT_DISPLAY_NAME
      : getUserDisplayName(item);
    const subtitle = isSelf ? 'Note to self'
      : tier === 'everyone' && item.sharedConversations ? `${item.sharedConversations} shared conversation${item.sharedConversations === 1 ? '' : 's'}`
      : '';
    return (
      <TouchableOpacity
        style={[styles.row, { backgroundColor: checked ? r.accentSoft : 'transparent' }]}
        onPress={() => handleSelect(item)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={mode === 'group' ? `${checked ? 'Remove' : 'Add'} ${name} ${checked ? 'from' : 'to'} the group` : `Message ${name}`}
        accessibilityState={mode === 'group' ? { selected: checked } : undefined}
      >
        <Avatar
          name={item.name}
          email={item.email}
          avatarUrl={item.avatarUrl}
          isBot={item.isBot}
          presenceStatus={live?.status || item.presenceStatus}
          size={40}
        />
        <View style={styles.rowText}>
          <View style={styles.rowTop}>
            <Text style={[type.bodyStrong, styles.name, { color: r.text }]} numberOfLines={1}>{name}</Text>
            <YouBadge isSelf={isSelf} compact />
            <BotBadge isBot={item.isBot} compact />
          </View>
          {!!subtitle && <Text style={[type.meta, { color: r.textMeta }]} numberOfLines={1}>{subtitle}</Text>}
        </View>
        {!item.isBot && !isSelf && (
          <TouchableOpacity
            onPress={event => { event.stopPropagation(); navigation.navigate('ContactProfile', { userId: item.id, ...(tier === 'everyone' && exactEmail ? { exactEmail } : {}) }); }}
            style={styles.rowAction}
            accessibilityRole="button"
            accessibilityLabel={`Profile for ${item.name || 'person'}`}
          >
            <Text style={[type.label, { color: r.textSecondary, fontWeight: '600' }]}>Profile</Text>
          </TouchableOpacity>
        )}
        {mode === 'direct' && (tier === 'everyone' || (tier === 'recent' && !friendIds.has(item.id))) && !item.isBot && !isSelf && (
          <TouchableOpacity
            onPress={(event) => { event.stopPropagation(); navigation.navigate('PersonEntry', { userId: item.id }); }}
            style={styles.rowAction}
            accessibilityRole="button"
          >
            <Text style={[type.label, { color: r.textSecondary, fontWeight: '600' }]}>Add friend</Text>
          </TouchableOpacity>
        )}
        {mode === 'group' && (
          <View style={[styles.check, { borderColor: checked ? r.accent : r.line, backgroundColor: checked ? r.accent : 'transparent' }]}>
            {checked && <AppIcon name="check" color={r.onAccent} size={14} strokeWidth={3} />}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: r.canvas }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.top}>
        <TextInput
          style={[styles.search, { backgroundColor: r.input, color: r.text, borderColor: r.line }]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or exact email"
          placeholderTextColor={r.decoration}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search people"
        />
        {mode === 'direct' ? (
          <ListRow icon="people" title="New group" onPress={() => { setMode('group'); setSelected([]); }} style={styles.newGroup} />
        ) : (
          <View style={styles.groupHeader}>
            <View style={styles.groupHeaderRow}>
              <Text accessibilityRole="header" style={[type.title, { color: r.text }]}>New group</Text>
              <Button size="sm" variant="ghost" label="Cancel" onPress={leaveGroup} />
            </View>
            <TextInput
              style={[styles.search, { backgroundColor: r.input, color: r.text, borderColor: r.line }]}
              value={groupTitle}
              onChangeText={setGroupTitle}
              placeholder={selected.length === 0 ? 'Group name (required)' : 'Group name (optional)'}
              placeholderTextColor={r.decoration}
              accessibilityLabel="Group name"
            />
            {selected.length > 0 && (
              <View style={styles.pillsRow}>
                {selected.map(u => {
                  const safeEmail = isPlaceholderEmail(u.email) ? '' : u.email;
                  const displayName = u.name || safeEmail || 'Unknown';
                  return <Chip key={u.id} label={displayName} icon="x" selected onPress={() => setSelected(prev => prev.filter(x => x.id !== u.id))} accessibilityLabel={`Remove ${displayName}`} />;
                })}
              </View>
            )}
          </View>
        )}
      </View>

      {searching && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={r.accent} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => item.key}
          // Keyboard handling (openchat-w1d): when the search keyboard is up it
          // used to cover the list with no way to scroll to the people behind
          // it. automaticallyAdjustKeyboardInsets insets the scroll area above
          // the keyboard (iOS); keyboardDismissMode lets you swipe it away;
          // keyboardShouldPersistTaps lets you tap a result without first
          // dismissing. paddingBottom keeps the last row clear of the keyboard.
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios' ? true : undefined}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space[6] }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.35}
          ListFooterComponent={loadingMore || (searching && items.length > 0) ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator color={r.accent} />
            </View>
          ) : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={[type.body, styles.emptyText, { color: r.textSecondary }]}>
                {trimmedQuery ? `No one named “${trimmedQuery}” yet.` : 'No one here yet.'}
              </Text>
              <Text style={[type.meta, styles.emptyText, { color: r.textMeta }]}>Invite them, or scan their code if they are with you.</Text>
              <View style={styles.emptyActions}>
                <Button variant="primary" icon="share" label="Invite a person" onPress={() => navigation.navigate('InvitePerson')} />
                <Button icon="camera" label="Scan a code" onPress={() => navigation.navigate('ScanQr')} />
              </View>
            </View>
          }
          renderItem={({ item }) => item.kind === 'header'
            ? <SectionLabel style={styles.sectionLabel}>{item.title}</SectionLabel>
            : renderPerson(item.user, item.tier)}
        />
      )}

      {mode === 'group' && (
        <View style={[styles.footer, { backgroundColor: r.card, borderColor: r.line }]}>
          <Button
            variant="primary"
            block
            disabled={!canCreateGroup}
            loading={creating}
            onPress={() => void handleCreateGroup()}
            label={selected.length === 0 ? 'Create group' : `Create group (${selected.length})`}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space[4], paddingTop: space[3] },
  top: { gap: space[2] },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: space[8] },
  loadingMore: { paddingVertical: space[4], alignItems: 'center' },
  search: {
    ...type.body,
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 2,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  newGroup: { paddingHorizontal: 0 },
  groupHeader: { gap: space[2], paddingTop: space[1] },
  groupHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[1] + 2 },
  sectionLabel: { marginTop: space[4] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space[2] + 2,
    marginHorizontal: -space[4],
    paddingHorizontal: space[4],
    gap: space[3],
    minHeight: 56,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  name: { flexShrink: 1 },
  rowAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space[2] },
  check: {
    width: 24, height: 24, borderRadius: radius.pill,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  empty: { alignItems: 'center', paddingTop: space[8], gap: space[2] },
  emptyText: { textAlign: 'center' },
  emptyActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2], marginTop: space[3] },
  footer: {
    marginHorizontal: -space[4],
    paddingHorizontal: space[4],
    paddingTop: space[3],
    paddingBottom: space[6],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
