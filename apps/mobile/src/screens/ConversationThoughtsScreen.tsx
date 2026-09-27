/**
 * ConversationThoughtsScreen — chat-scoped Thoughts view.
 *
 * Opened from a chat's header or overflow menu. Shows two sections:
 *   Pinned          — thoughts pinned to this conversation by any participant
 *                     (pinning shares the thought with the whole chat)
 *   From this chat  — all participants' shared #hashtag captures plus the
 *                     caller's private "Save to Thoughts" captures
 *
 * Parity with ThoughtsScreen:
 *   - Debounced server-side search (?q=) across text and tags
 *   - Clear affordance restoring the full chat-scoped list
 *   - Two-way empty states (no results for this search vs no thoughts yet)
 *   - Tag-chip filtering (tap #tag -> filters search)
 *   - Live socket updates (thought:created, thought:shared, thought:pinned, etc.)
 *   - Inline composer & index-card editor
 */

import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useChat } from '../contexts/ChatContext';
import {
  fetchConversationThoughts,
  createThought,
  updateThought,
  pinThought,
  unpinThought,
  deleteThought,
  Thought,
} from '../services/thoughts';
import { getSocket } from '../api/socket';
import { ThoughtCard } from '../components/ThoughtCard';
import { ThoughtsSearchBar } from '../components/ThoughtsSearchBar';
import { AppIcon } from '../components/AppIcon';
import type { RouteProps } from '../navigation/types';

export function ConversationThoughtsScreen() {
  const route = useRoute<RouteProps<'ConversationThoughts'>>();
  const { conversationId, title } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser } = useChat();
  const myId = currentUser?.userId;

  const [pinned, setPinned] = useState<Thought[]>([]);
  const [fromChat, setFromChat] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const activeQueryRef = useRef('');
  const queryRef = useRef('');
  queryRef.current = query;

  const load = useCallback(
    async (isRefresh = false, q = '') => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const trimmed = q.trim();
        const data = await fetchConversationThoughts(
          conversationId,
          trimmed ? { q: trimmed } : undefined
        );
        if (mountedRef.current) {
          activeQueryRef.current = trimmed;
          setPinned(data.pinned);
          setFromChat(data.fromChat);
        }
      } catch (e) {
        if (mountedRef.current) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [conversationId]
  );

  // Reload when the screen comes into focus, honoring query
  useFocusEffect(
    useCallback(() => {
      load(false, queryRef.current);
    }, [load])
  );

  // Debounced search: refetch with `q` ~250ms after typing stops (mirrors ThoughtsScreen)
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const timer = setTimeout(() => {
      load(false, query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  // Tag chip tap filters the search query
  const handleTagPress = useCallback((tag: string) => {
    setQuery(tag.replace(/^#/, ''));
  }, []);

  // Live tag/pin/creation updates from participants in this conversation
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;

    const matchesQuery = (t: Thought) => {
      if (!activeQueryRef.current) return true;
      const q = activeQueryRef.current.toLowerCase();
      return (
        t.text.toLowerCase().includes(q) ||
        t.tags?.some((tag) => tag.toLowerCase().includes(q))
      );
    };

    const onCreated = (payload: { thought: Thought }) => {
      if (!payload?.thought) return;
      const t = payload.thought;
      // Must be relevant to this conversation
      if (t.sourceConversationId !== conversationId && !t.pinned) return;
      if (!matchesQuery(t)) return;

      if (t.pinned) {
        setPinned((prev) => (prev.some((x) => x.id === t.id) ? prev : [{ ...t, pinned: true }, ...prev]));
      } else {
        setFromChat((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
      }
    };

    const onShared = (p: { conversationId: string; thought: Thought }) => {
      if (p?.conversationId !== conversationId || !p.thought) return;
      if (!matchesQuery(p.thought)) return;
      setFromChat((prev) => {
        if (prev.some((t) => t.id === p.thought.id)) {
          return prev.map((t) => (t.id === p.thought.id ? p.thought : t));
        }
        return [p.thought, ...prev];
      });
    };

    const onPinned = (p: { conversationId: string; thought: Thought }) => {
      if (p?.conversationId !== conversationId || !p.thought) return;
      if (!matchesQuery(p.thought)) return;
      setPinned((prev) => {
        if (prev.some((t) => t.id === p.thought.id)) {
          return prev.map((t) => (t.id === p.thought.id ? p.thought : t));
        }
        return [p.thought, ...prev];
      });
      setFromChat((prev) => prev.filter((t) => t.id !== p.thought.id));
    };

    const onUnpinned = (p: { conversationId: string; thoughtId: string }) => {
      if (p?.conversationId !== conversationId) return;
      setPinned((prev) => prev.filter((t) => t.id !== p.thoughtId));
      void load(true, queryRef.current);
    };

    const onUpdated = (p: { thought: Thought }) => {
      if (!p?.thought) return;
      setPinned((prev) => prev.map((t) => (t.id === p.thought.id ? { ...t, ...p.thought } : t)));
      setFromChat((prev) => prev.map((t) => (t.id === p.thought.id ? { ...t, ...p.thought } : t)));
    };

    const onUnshared = (p: { conversationId: string; thoughtId: string }) => {
      if (p?.conversationId !== conversationId || !p.thoughtId) return;
      setFromChat((prev) => prev.filter((t) => t.id !== p.thoughtId));
      setPinned((prev) => prev.filter((t) => t.id !== p.thoughtId));
    };

    sock.on('thought:created', onCreated);
    sock.on('thought:shared', onShared);
    sock.on('thought:unshared', onUnshared);
    sock.on('thought:pinned', onPinned);
    sock.on('thought:unpinned', onUnpinned);
    sock.on('thought:updated', onUpdated);
    return () => {
      sock.off('thought:created', onCreated);
      sock.off('thought:shared', onShared);
      sock.off('thought:unshared', onUnshared);
      sock.off('thought:pinned', onPinned);
      sock.off('thought:unpinned', onUnpinned);
      sock.off('thought:updated', onUpdated);
    };
  }, [conversationId, load]);

  const handleTogglePin = useCallback(
    async (t: Thought, isPinned: boolean) => {
      try {
        if (isPinned) {
          await unpinThought(t.id, conversationId);
        } else {
          await pinThought(t.id, conversationId);
        }
        await load(true, queryRef.current);
      } catch (e) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Pin change failed');
      }
    },
    [conversationId, load]
  );

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteThought(id);
      setPinned((prev) => prev.filter((t) => t.id !== id));
      setFromChat((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to delete');
    }
  }, []);

  const mine = (t: Thought) => !t.authorId || t.authorId === myId;

  // ── Inline editing ───────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const openAdd = useCallback(() => {
    setEditingId(null);
    setCreating(true);
    setNewDraft('');
  }, []);

  const startEdit = useCallback((thought: Thought) => {
    setCreating(false);
    setEditingId(thought.id);
    setEditDraft(thought.text);
  }, []);

  const commitNew = useCallback(async () => {
    const text = newDraft.trim();
    setCreating(false);
    setNewDraft('');
    if (!text) return;
    try {
      const t = await createThought({ text, pinToConversationId: conversationId });
      setPinned((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save thought');
    }
  }, [newDraft, conversationId]);

  const commitEdit = useCallback(async () => {
    const id = editingId;
    const text = editDraft.trim();
    setEditingId(null);
    if (!id || !text) return;
    const orig = [...pinned, ...fromChat].find((t) => t.id === id);
    if (orig && orig.text === text) return;

    try {
      const updated = await updateThought(id, { text });
      setPinned((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      setFromChat((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save edit');
    }
  }, [editingId, editDraft, pinned, fromChat]);

  const renderEditorCard = (
    value: string,
    onChange: (t: string) => void,
    onBlur: () => void,
    placeholder?: string
  ) => (
    <View
      style={[
        styles.editorCard,
        { backgroundColor: c.surface, borderColor: c.border, borderLeftColor: c.primary },
      ]}
    >
      <TextInput
        style={[styles.editorInput, { color: c.textPrimary }]}
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        placeholder={placeholder ?? 'Write a thought…'}
        placeholderTextColor={c.textMuted}
        multiline
        autoFocus
      />
    </View>
  );

  const isSearching = query.trim().length > 0;
  const totalCount = pinned.length + fromChat.length;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {/* Search bar — parity with ThoughtsScreen */}
      <ThoughtsSearchBar
        value={query}
        onChangeText={setQuery}
        placeholder="Search thoughts in this chat"
      />

      {/* Scope header — confirms the chat scope explicitly */}
      <View style={[styles.scopeHeader, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <AppIcon name="thought" color={c.primary} size={15} />
        <Text style={[styles.scopeHeaderText, { color: c.textMetadata }]} numberOfLines={1}>
          Chat Thoughts · <Text style={{ color: c.textPrimary, fontWeight: '600' }}>{title || 'This conversation'}</Text>
        </Text>
      </View>

      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true, queryRef.current)}
            tintColor={c.primary}
          />
        }
      >
        {error && <Text style={[styles.error, { color: c.danger }]}>{error}</Text>}

        {/* Global empty state when searching and no results in either section */}
        {isSearching && totalCount === 0 && !loading && (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: c.textMetadata, textAlign: 'center' }]}>
              No thoughts match &ldquo;{query.trim()}&rdquo; in this chat.
            </Text>
            <TouchableOpacity
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={[
                styles.clearSearchBtn,
                { backgroundColor: c.surfaceElevated, borderColor: c.border },
              ]}
            >
              <Text style={{ color: c.primary, fontWeight: '600', fontSize: 14 }}>Clear search</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Pinned section — show when not searching or when there are pinned matches */}
        {(!isSearching || pinned.length > 0) && (
          <>
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>
              {isSearching ? `Pinned matches (${pinned.length})` : 'Pinned'}
            </Text>
            {creating &&
              renderEditorCard(
                newDraft,
                setNewDraft,
                () => void commitNew(),
                'New pinned thought…'
              )}
            {pinned.length === 0 && !loading && !creating && !isSearching && (
              <Text style={[styles.emptyText, { color: c.textMetadata }]}>
                Nothing pinned yet. Long-press a message and choose “Save & pin to chat”, or tap + to add one.
              </Text>
            )}
            {pinned.map((t) =>
              t.id === editingId ? (
                renderEditorCard(editDraft, setEditDraft, () => void commitEdit())
              ) : (
                <ThoughtCard
                  key={t.id}
                  item={{ ...t, pinned: true }}
                  subtitle={mine(t) ? 'pinned by you' : `by ${t.authorName || 'a participant'}`}
                  onPress={mine(t) ? () => startEdit(t) : undefined}
                  onDelete={mine(t) ? () => handleDelete(t.id) : undefined}
                  onTogglePin={mine(t) || t.pinnedBy === myId ? () => handleTogglePin(t, true) : undefined}
                  onTagPress={handleTagPress}
                />
              )
            )}
          </>
        )}

        {/* From this chat section — show when not searching or when there are chat matches */}
        {(!isSearching || fromChat.length > 0) && (
          <>
            <Text
              style={[
                styles.sectionTitle,
                { color: c.textSecondary, marginTop: !isSearching || pinned.length > 0 ? 18 : 0 },
              ]}
            >
              {isSearching ? `From this chat (${fromChat.length})` : 'From this chat'}
            </Text>
            {fromChat.length === 0 && !loading && !isSearching && (
              <Text style={[styles.emptyText, { color: c.textMetadata }]}>
                Shared tags from this chat land here — use #fact, #idea, #todo… in a message, or long-press a message → “Save to Thoughts” for a private capture.
              </Text>
            )}
            {fromChat.map((t) =>
              t.id === editingId ? (
                renderEditorCard(editDraft, setEditDraft, () => void commitEdit())
              ) : (
                <ThoughtCard
                  key={t.id}
                  item={{ ...t, pinned: false }}
                  subtitle={mine(t) ? undefined : `by ${t.authorName || 'a participant'}`}
                  onPress={mine(t) ? () => startEdit(t) : undefined}
                  onDelete={mine(t) ? () => handleDelete(t.id) : undefined}
                  onTogglePin={mine(t) ? () => handleTogglePin(t, false) : undefined}
                  onTagPress={handleTagPress}
                />
              )
            )}
          </>
        )}
      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.primary }]}
        onPress={openAdd}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="New thought in this chat"
      >
        <AppIcon name="plus" color={c.onPrimary} size={26} strokeWidth={2.2} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scopeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scopeHeaderText: {
    fontSize: 12,
  },
  content: { padding: 12, paddingBottom: 88 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  emptyContainer: {
    paddingVertical: 36,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  clearSearchBtn: {
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: {
    fontSize: 14,
    marginBottom: 10,
  },
  editorCard: {
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 14,
    marginBottom: 10,
  },
  editorInput: {
    fontSize: 15,
    lineHeight: 22,
    minHeight: 44,
    padding: 0,
  },
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
});
