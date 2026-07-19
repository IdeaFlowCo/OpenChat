/**
 * Thoughts list screen — shows the user's personal notes feed. (OpenChat-zi1)
 *
 * Each card shows: text, kind badge (color-coded), status badge, relative time,
 * and edit/delete actions.
 *
 * - Tap a card → edit modal
 * - Long-press a card → delete confirmation
 * - FAB (+) → add modal
 * - Pull-to-refresh
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { fetchThoughts, deleteThought, Thought } from '../services/thoughts';
import { api, Conversation, Message, ThoughtKind } from '../api/client';
import { getSocket } from '../api/socket';
import type { ThoughtsNavProp } from '../navigation/types';
import {
  DestinationComposerPrototype,
  ThoughtStreamLensBar,
} from '../prototypes/DestinationComposerPrototype';
import { isThoughtStreamPrototype } from '../prototypes/flags';

// ── Badge colors ──────────────────────────────────────────────────────────────

const KIND_COLORS: Record<string, string> = {
  fact:        '#6366f1', // indigo
  decision:    '#f59e0b', // amber
  commitment:  '#10b981', // emerald
  reminder:    '#f97316', // orange
  observation: '#3b82f6', // blue
};

const KIND_LABELS: Record<string, string> = {
  fact:        'Fact',
  decision:    'Decision',
  commitment:  'Commitment',
  reminder:    'Reminder',
  observation: 'Observation',
};

const TAG_TO_KIND: Record<string, ThoughtKind> = {
  fact: 'fact',
  decision: 'decision',
  commitment: 'commitment',
  commit: 'commitment',
  reminder: 'reminder',
  todo: 'reminder',
  observation: 'observation',
  thought: 'observation',
  note: 'observation',
};

const TAG_RE = /#([a-zA-Z]+)/g;

function extractTags(content: string): Array<{ name: string; kind: ThoughtKind }> {
  const seen = new Set<string>();
  const tags: Array<{ name: string; kind: ThoughtKind }> = [];
  for (const match of content.matchAll(TAG_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tags.push({ name, kind: TAG_TO_KIND[name] ?? 'observation' });
    if (tags.length >= 5) break;
  }
  return tags;
}

function thoughtDedupKey(thought: Thought): string {
  const tag = (thought.tags?.[0] ?? '').replace(/^#/, '').toLowerCase();
  return thought.sourceMessageId && tag ? `${thought.sourceMessageId}:${tag}` : thought.id;
}

function projectConversationTagThoughts(
  messages: Message[],
  conversation: Conversation | undefined,
  currentUserId: string | undefined,
  query: string
): Thought[] {
  const trimmedQuery = query.trim().replace(/^#/, '').toLowerCase();
  const sourceConversationName = conversation?.title
    || (conversation?.type === 'group' ? 'Group chat' : 'Chat');

  return messages.flatMap((message) => {
    if (message.deletedAt || !message.content?.trim()) return [];
    return extractTags(message.content).map((tag) => {
      const authorName = message.sender?.name
        || message.sender?.email?.split('@')[0]
        || (message.senderId === currentUserId ? 'You' : 'Group member');
      const thought: Thought = {
        id: `conversation-tag:${message.id}:${tag.name}`,
        text: message.content.trim(),
        kind: tag.kind,
        status: 'none',
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        tags: [tag.name],
        ownerId: message.senderId,
        authorName,
        isOwn: message.senderId === currentUserId,
        sourceMessageId: message.id,
        sourceConversationId: message.conversationId,
        sourceConversationName,
        sourceConversationType: conversation?.type,
      };
      return thought;
    });
  }).filter((thought) => {
    if (!trimmedQuery) return true;
    return thought.text.toLowerCase().includes(trimmedQuery)
      || (thought.tags ?? []).some((tag) => tag.toLowerCase().includes(trimmedQuery));
  });
}

function mergeThoughtLists(primary: Thought[], projected: Thought[]): Thought[] {
  const seen = new Set(primary.map(thoughtDedupKey));
  const merged = [...primary];
  for (const thought of projected) {
    const key = thoughtDedupKey(thought);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(thought);
  }
  return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── ThoughtCard ───────────────────────────────────────────────────────────────

interface ThoughtCardProps {
  item: Thought;
  onEdit?: () => void;
  onDelete?: () => void;
  onOpenSource?: () => void;
  onTagPress: (tag: string) => void;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  chipBg: string;
  chipText: string;
}

function ThoughtCard({
  item,
  onEdit,
  onDelete,
  onOpenSource,
  onTagPress,
  surface,
  border,
  textPrimary,
  textSecondary,
  textMuted,
  chipBg,
  chipText,
}: ThoughtCardProps) {
  const kindColor = KIND_COLORS[item.kind] ?? '#3b82f6';
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;
  const tags = item.tags ?? [];
  const isShared = item.isOwn === false;
  const primaryAction = onEdit ?? onOpenSource;

  return (
    <TouchableOpacity
      onPress={primaryAction}
      disabled={!primaryAction}
      onLongPress={onDelete ? () =>
        Alert.alert('Delete thought?', item.text.slice(0, 80), [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: onDelete },
        ])
        : undefined}
      activeOpacity={0.7}
      style={[styles.card, { backgroundColor: surface, borderColor: border }]}
    >
      {/* Header: time leads; status + the kind pill float to the right. The
          kind pill is hidden for 'observation' (the catch-all default for any
          tag) to keep cards quiet — only meaningful types show. */}
      <View style={styles.cardHeader}>
        <Text style={[styles.time, { color: textMuted }]}>
          {formatRelativeTime(item.createdAt)}
        </Text>
        {isShared && (
          <Text style={[styles.author, { color: textSecondary }]} numberOfLines={1}>
            {item.authorName || 'Group member'}
          </Text>
        )}
        {item.status !== 'none' && (
          <View
            style={[
              styles.badge,
              styles.headerRight,
              { backgroundColor: item.status === 'open' ? '#3b82f622' : '#6b728022' },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                { color: item.status === 'open' ? '#3b82f6' : '#6b7280' },
              ]}
            >
              {item.status === 'open' ? 'Open' : 'Closed'}
            </Text>
          </View>
        )}
        {item.kind !== 'observation' && (
          <View style={[styles.badge, item.status === 'none' ? styles.headerRight : null, { backgroundColor: kindColor + '22' }]}>
            <Text style={[styles.badgeText, { color: kindColor }]}>{kindLabel}</Text>
          </View>
        )}
      </View>

      {/* Body text */}
      <Text style={[styles.bodyText, { color: textPrimary }]}>{item.text}</Text>

      {item.sourceConversationId && (
        <TouchableOpacity
          onPress={(event) => {
            event.stopPropagation();
            onOpenSource?.();
          }}
          disabled={!onOpenSource}
          style={[styles.provenanceRow, { borderColor: border }]}
          accessibilityRole="button"
          accessibilityLabel={`Open source chat ${item.sourceConversationName || ''}`.trim()}
        >
          <Text style={[styles.provenanceText, { color: textSecondary }]} numberOfLines={1}>
            {isShared ? 'Shared in ' : 'From '}
            {item.sourceConversationName || (item.sourceConversationType === 'group' ? 'Group chat' : 'Chat')}
          </Text>
          <Text style={[styles.provenanceArrow, { color: textMuted }]}>›</Text>
        </TouchableOpacity>
      )}

      {/* Tag chips — visually distinct from the kind badge (pill, monospace #). */}
      {tags.length > 0 && (
        <View style={styles.tagRow}>
          {tags.map((tag) => (
            <TouchableOpacity
              key={tag}
              onPress={(event) => {
                event.stopPropagation();
                onTagPress(tag);
              }}
              activeOpacity={0.7}
              style={[styles.chip, { backgroundColor: chipBg }]}
            >
              <Text style={[styles.chipText, { color: chipText }]}>
                #{tag.replace(/^#/, '')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── ThoughtsScreen ────────────────────────────────────────────────────────────

export function ThoughtsScreen() {
  const navigation = useNavigation<ThoughtsNavProp<'ThoughtsList'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { setActiveConversation, currentUser, conversations } = useChat();

  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // The query currently reflected in `thoughts`. Used so socket-pushed
  // thought:created events only prepend when we're showing the full list.
  const activeQueryRef = useRef('');
  const selectedConversationRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  selectedConversationRef.current = selectedConversationId;
  conversationsRef.current = conversations;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (
    isRefresh = false,
    q = '',
    conversationId = selectedConversationRef.current
  ) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const trimmed = q.trim();
      const data = await fetchThoughts({
        limit: 50,
        ...(trimmed ? { q: trimmed } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      let visibleThoughts = conversationId
        ? data.filter((thought) => thought.sourceConversationId === conversationId)
        : data;
      if (conversationId) {
        const conversation = conversationsRef.current.find((item) => item.id === conversationId);
        const { messages } = await api.getMessages(conversationId);
        const visibleMessages = conversation?.type === 'group'
          ? messages
          : messages.filter((message) => message.senderId === currentUser?.userId);
        visibleThoughts = mergeThoughtLists(
          visibleThoughts,
          projectConversationTagThoughts(visibleMessages, conversation, currentUser?.userId, trimmed)
        );
      }
      if (mountedRef.current) {
        activeQueryRef.current = trimmed;
        setThoughts(visibleThoughts);
      }
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Reload whenever the screen comes into focus (e.g., returning from add/edit),
  // honoring whatever search query is active. We read the query from a ref so
  // this effect doesn't re-fire on every keystroke (the debounce below owns that).
  const queryRef = useRef('');
  queryRef.current = query;
  useFocusEffect(useCallback(() => { load(false, queryRef.current); }, [load]));

  // Debounced search: refetch with `q` ~250ms after typing stops. Clearing
  // the input falls back to the normal full list. Skipped on first mount —
  // the focus effect already did the initial load.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const timer = setTimeout(() => { load(false, query, selectedConversationId); }, 250);
    return () => clearTimeout(timer);
  }, [query, selectedConversationId, load]);

  // Live update on tag-generated Thoughts: server emits 'thought:created'
  // when a chat message with a hashtag spawns a new Thought. Prepend so
  // newest-first ordering matches the load() fetch.
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const handler = (payload: { thought: Thought }) => {
      if (!payload?.thought) return;
      // While a search is active the list is filtered server-side; don't
      // blindly prepend a new thought that may not match the query.
      if (activeQueryRef.current) return;
      if (
        selectedConversationRef.current
        && payload.thought.sourceConversationId !== selectedConversationRef.current
      ) return;
      const thought = {
        ...payload.thought,
        isOwn: payload.thought.ownerId
          ? payload.thought.ownerId === currentUser?.userId
          : payload.thought.isOwn,
      };
      setThoughts((prev) => {
        // Idempotency: if we already have it (e.g. focus-load raced), skip.
        if (prev.some((t) => t.id === thought.id)) return prev;
        return [thought, ...prev];
      });
    };
    sock.on('thought:created', handler);
    return () => { sock.off('thought:created', handler); };
  }, [currentUser?.userId]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteThought(id);
      if (mountedRef.current) {
        setThoughts((prev) => prev.filter((t) => t.id !== id));
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to delete');
    }
  }, []);

  const openAdd = useCallback(() => {
    navigation.navigate('AddEditThought', undefined);
  }, [navigation]);

  const openEdit = useCallback(
    (thought: Thought) => {
      navigation.navigate('AddEditThought', { thought });
    },
    [navigation]
  );

  // Tapping a tag chip filters the list to that tag.
  const handleTagPress = useCallback((tag: string) => {
    setQuery(tag.replace(/^#/, ''));
  }, []);

  const handleThoughtCreated = useCallback((thought: Thought) => {
    if (activeQueryRef.current || selectedConversationRef.current) {
      void load(false, queryRef.current, selectedConversationRef.current);
      return;
    }
    setThoughts((current) => (
      current.some((item) => item.id === thought.id) ? current : [thought, ...current]
    ));
  }, [load]);

  const openConversation = useCallback((conversationId: string) => {
    setActiveConversation(conversationId);
    const tabNavigation = navigation.getParent() as unknown as {
      navigate: (name: string, params?: object) => void;
    } | undefined;
    tabNavigation?.navigate('ChatsTab', {
      screen: 'Chat',
      params: { conversationId },
    });
  }, [navigation, setActiveConversation]);

  // Empty state — distinct copy for "no results for a search" vs "no thoughts yet".
  const renderEmpty = () => {
    if (loading) return null;
    const searching = query.trim().length > 0;
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyText, { color: c.textMuted }]}>
          {searching
            ? `No thoughts match "${query.trim()}".`
            : selectedConversationId
              ? 'No tagged thoughts in this chat yet.'
              : 'No thoughts yet. Tap + to add one.'}
        </Text>
      </View>
    );
  };

  if (error && thoughts.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
        <TouchableOpacity onPress={() => load(false)} style={styles.retryButton}>
          <Text style={{ color: c.primary }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ThoughtStreamLensBar
        selectedConversationId={selectedConversationId}
        onSelectConversation={setSelectedConversationId}
      />

      {/* Search bar — mirrors the SearchScreen pattern for consistency. */}
      <View style={[styles.searchWrap, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          style={[
            styles.searchInput,
            { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border },
          ]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search thoughts and tags"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      <FlatList
        data={thoughts}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const isOwn = item.isOwn ?? (!item.ownerId || item.ownerId === currentUser?.userId);
          return (
            <ThoughtCard
              item={item}
              onEdit={isOwn ? () => openEdit(item) : undefined}
              onDelete={isOwn ? () => handleDelete(item.id) : undefined}
              onOpenSource={item.sourceConversationId
                ? () => openConversation(item.sourceConversationId!)
                : undefined}
              onTagPress={handleTagPress}
              surface={c.surface}
              border={c.border}
              textPrimary={c.textPrimary}
              textSecondary={c.textSecondary}
              textMuted={c.textMuted}
              chipBg={c.primaryMuted}
              chipText={c.primary}
            />
          );
        }}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={c.primary}
          />
        }
      />

      {isThoughtStreamPrototype ? (
        <DestinationComposerPrototype onThoughtCreated={handleThoughtCreated} />
      ) : (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: c.primary }]}
          onPress={openAdd}
          activeOpacity={0.8}
        >
          <Text style={styles.fabIcon}>+</Text>
        </TouchableOpacity>
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
  searchInput: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  list: { padding: 12, paddingBottom: 88 },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  time: {
    fontSize: 11,
  },
  author: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '600',
  },
  // Pushes the first trailing element (status or kind pill) to the right edge.
  headerRight: {
    marginLeft: 'auto',
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 22,
  },
  provenanceRow: {
    minHeight: 34,
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  provenanceText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
  },
  provenanceArrow: {
    fontSize: 18,
    lineHeight: 20,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999, // fully rounded pill — distinct from the squared kind badge
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retryButton: { padding: 8 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabIcon: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '300',
  },
});
