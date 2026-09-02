/**
 * Search — combined search across messages and conversations, plus exact-email
 * people discovery.
 *
 * Mirrors the web client's SearchResultsPanel in ChatSidebar.tsx but
 * presents as a full-screen modal on mobile. Three result sections,
 * tap-through behavior:
 *   - Conversation hit → opens the conversation
 *   - Message hit → opens its host conversation (no scroll-to-msg yet)
 *   - Contact hit → starts/opens a DM with them
 *
 * Server endpoint: GET /api/chat/search?q=&scope=global (OpenChat-kma)
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import {
  api,
  SearchResults,
  SearchMessageHit,
  SearchConversationHit,
  User,
} from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import type { NavProp } from '../navigation/types';
import {
  getDirectConversationParticipant,
  getDirectConversationTitle,
  isSelfDirectConversation,
} from '../utils/conversationDisplay';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(iso).toLocaleDateString();
}

interface RowMessage { kind: 'msg'; hit: SearchMessageHit; }
interface RowConv    { kind: 'conv'; hit: SearchConversationHit; }
interface RowContact { kind: 'contact'; hit: User; }
interface RowHeader  { kind: 'header'; label: string; count: number; key: string; }
type Row = RowMessage | RowConv | RowContact | RowHeader;

export function SearchScreen() {
  const navigation = useNavigation<NavProp<'Search'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { conversations, currentUser, createConversation } = useChat();
  const inputRef = useRef<TextInput>(null);

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  // Focus the input on mount.
  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Search' });
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [navigation]);

  // Debounced fetch. We keep prior results visible while the new query
  // is in flight (avoids the panel flashing empty between keystrokes).
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api.search({ q: trimmed, scope: 'global', limit: 25 })
        .then(res => { if (!cancelled) setResults(res); })
        .catch(err => {
          if (!cancelled) console.warn('[Search] search failed:', err);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  // Flatten the three buckets into a single FlatList with section headers.
  // OpenChat-search-self: any contact hit whose id matches the current user
  // becomes a top-level "You" section, separate from "People" — tap = self-DM.
  const rows: Row[] = useMemo(() => {
    if (!results) return [];
    const out: Row[] = [];

    // Pull self-hit out of the contacts bucket so it gets a dedicated header.
    const me = currentUser?.userId;
    const selfHit = me ? results.contacts.find((u) => u.id === me) : undefined;
    const otherContacts = me ? results.contacts.filter((u) => u.id !== me) : results.contacts;

    if (selfHit) {
      out.push({ kind: 'header', label: 'You', count: 1, key: 'h-you' });
      out.push({ kind: 'contact', hit: selfHit });
    }
    if (results.conversations.length > 0) {
      out.push({ kind: 'header', label: 'Conversations', count: results.conversations.length, key: 'h-conv' });
      for (const c of results.conversations) out.push({ kind: 'conv', hit: c });
    }
    if (results.messages.length > 0) {
      out.push({ kind: 'header', label: 'Messages', count: results.messages.length, key: 'h-msg' });
      for (const m of results.messages) out.push({ kind: 'msg', hit: m });
    }
    if (otherContacts.length > 0) {
      out.push({ kind: 'header', label: 'People', count: otherContacts.length, key: 'h-people' });
      for (const u of otherContacts) out.push({ kind: 'contact', hit: u });
    }
    return out;
  }, [results, currentUser?.userId]);

  const openConversation = (conversationId: string) => {
    navigation.replace('Chat', { conversationId });
  };

  const openContact = async (u: User) => {
    if (opening) return;
    setOpening(u.id);
    try {
      const conv = await createConversation([u.id], { type: 'direct' });
      navigation.replace('Chat', { conversationId: conv.id });
    } catch (err) {
      Alert.alert('Could not open chat', err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'header') {
      return (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
            {item.label.toUpperCase()} · {item.count}
          </Text>
        </View>
      );
    }
    if (item.kind === 'conv') {
      const h = item.hit;
      const isGroup = h.type === 'group';
      const other = !isGroup ? getDirectConversationParticipant(h, currentUser) : null;
      const title = isGroup
        ? h.title || 'Group'
        : getDirectConversationTitle(h, currentUser, 'Group');
      return (
        <TouchableOpacity
          style={[styles.row, { borderColor: c.divider }]}
          onPress={() => openConversation(h.id)}
          activeOpacity={0.7}
        >
          <Avatar name={title} email={other?.email} isBot={other?.isBot} size={40} />
          <View style={{ flex: 1 }}>
            <View style={styles.rowTop}>
              <Text style={[styles.rowTitle, { color: c.textPrimary }]} numberOfLines={1}>{title}</Text>
              {!isGroup && <BotBadge isBot={other?.isBot} compact />}
              <Text style={[styles.rowTime, { color: c.textMuted }]}>{relativeTime(h.lastMessageAt)}</Text>
            </View>
            {h.lastMessagePreview && (
              <Text style={[styles.rowPreview, { color: c.textSecondary }]} numberOfLines={1}>
                {h.lastMessagePreview}
              </Text>
            )}
          </View>
        </TouchableOpacity>
      );
    }
    if (item.kind === 'msg') {
      const h = item.hit;
      const senderName = h.sender?.name || h.sender?.email?.split('@')[0] || 'someone';
      const conversation = conversations.find(candidate => candidate.id === h.conversationId);
      const inLabel = conversation && isSelfDirectConversation(conversation, currentUser)
        ? getDirectConversationTitle(conversation, currentUser, 'Group chat')
        : h.conversationTitle || (h.conversationType === 'direct' ? `DM with ${senderName}` : 'Group chat');
      return (
        <TouchableOpacity
          style={[styles.row, { borderColor: c.divider }]}
          onPress={() => openConversation(h.conversationId)}
          activeOpacity={0.7}
        >
          <Avatar name={h.sender?.name || h.sender?.email} email={h.sender?.email} isBot={h.sender?.isBot} size={40} />
          <View style={{ flex: 1 }}>
            <View style={styles.rowTop}>
              <Text style={[styles.rowTitle, { color: c.textPrimary }]} numberOfLines={1}>
                {senderName}
              </Text>
              <BotBadge isBot={h.sender?.isBot} compact />
              <Text style={[styles.rowTime, { color: c.textMuted }]}>{relativeTime(h.createdAt)}</Text>
            </View>
            <Text style={[styles.rowPreview, { color: c.textPrimary }]} numberOfLines={2}>
              {h.content}
            </Text>
            <Text style={[styles.msgIn, { color: c.textMuted }]} numberOfLines={1}>
              in {inLabel}
            </Text>
          </View>
        </TouchableOpacity>
      );
    }
    // contact
    const u = item.hit;
    return (
      <TouchableOpacity
        style={[styles.row, { borderColor: c.divider, opacity: opening === u.id ? 0.5 : 1 }]}
        onPress={() => openContact(u)}
        disabled={opening === u.id}
        activeOpacity={0.7}
      >
        <Avatar name={u.name} email={u.email} isBot={u.isBot} size={40} />
        <View style={{ flex: 1 }}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowTitle, { color: c.textPrimary }]} numberOfLines={1}>
              {u.name || u.email}
            </Text>
            <BotBadge isBot={u.isBot} compact />
          </View>
          <Text style={[styles.rowPreview, { color: c.textSecondary }]} numberOfLines={1}>
            {u.email}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const trimmed = query.trim();
  const showEmpty = !!results && trimmed.length >= MIN_QUERY_LEN && rows.length === 0;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={[styles.searchWrap, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          ref={inputRef}
          style={[styles.input, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]}
          value={query}
          onChangeText={setQuery}
          placeholder={currentUser?.canBrowseUserDirectory
            ? 'Search chats or people'
            : 'Search chats; full email finds people'}
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {trimmed.length < MIN_QUERY_LEN ? (
        <View style={styles.empty}>
          <Text style={{ color: c.textSecondary, textAlign: 'center', paddingHorizontal: 32 }}>
            {currentUser?.canBrowseUserDirectory
              ? 'Search messages, conversations, and people by name or email.'
              : 'Search messages and conversations. To find a person, enter their complete email address.'}
          </Text>
        </View>
      ) : showEmpty && !loading ? (
        <View style={styles.empty}>
          <Text style={{ color: c.textSecondary, textAlign: 'center' }}>
            No results for "{trimmed}"
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={r => r.kind === 'header' ? r.key : r.hit.id}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={loading ? (
            <View style={styles.loadingBar}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: {
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  loadingBar: { paddingVertical: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 48 },
  section: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  rowTime: { fontSize: 11, marginLeft: 'auto' },
  rowPreview: { fontSize: 13, marginTop: 2 },
  msgIn: { fontSize: 11, marginTop: 4, fontStyle: 'italic' },
});
