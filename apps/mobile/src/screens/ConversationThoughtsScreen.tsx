/**
 * ConversationThoughtsScreen — chat-scoped Thoughts view.
 *
 * Opened from a chat's header (thought-bubble icon). Shows two sections:
 *   Pinned          — thoughts pinned to this conversation by any participant
 *                     (pinning shares the thought with the whole chat)
 *   From this chat  — all participants' shared #hashtag captures plus the
 *                     caller's private "Save to Thoughts" captures
 *
 * Pin toggles: own thoughts can be pinned/unpinned; another participant's
 * pinned thought can't be modified here. Long-press deletes own thoughts.
 * Live updates via 'thought:shared' / 'thought:pinned' /
 * 'thought:unpinned' / 'thought:updated' socket events.
 */

import { useCallback, useEffect, useState, useRef } from 'react';
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
import { useRoute } from '@react-navigation/native';
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
import { AppIcon } from '../components/AppIcon';
import type { RouteProps } from '../navigation/types';

export function ConversationThoughtsScreen() {
  const route = useRoute<RouteProps<'ConversationThoughts'>>();
  const { conversationId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser } = useChat();
  const myId = currentUser?.userId;

  const [pinned, setPinned] = useState<Thought[]>([]);
  const [fromChat, setFromChat] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await fetchConversationThoughts(conversationId);
      setPinned(data.pinned);
      setFromChat(data.fromChat);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load]);

  // Live tag/pin updates from participants in this conversation.
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onShared = (p: { conversationId: string; thought: Thought }) => {
      if (p?.conversationId !== conversationId || !p.thought) return;
      setFromChat((prev) => {
        if (prev.some((t) => t.id === p.thought.id)) {
          return prev.map((t) => (t.id === p.thought.id ? p.thought : t));
        }
        return [p.thought, ...prev];
      });
    };
    const onPinned = (p: { conversationId: string; thought: Thought }) => {
      if (p?.conversationId !== conversationId || !p.thought) return;
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
      void load(true);
    };
    const onUpdated = (p: { thought: Thought }) => {
      if (!p?.thought) return;
      setPinned((prev) => prev.map((t) => (t.id === p.thought.id ? { ...t, ...p.thought } : t)));
      setFromChat((prev) => prev.map((t) => (t.id === p.thought.id ? { ...t, ...p.thought } : t)));
    };
    sock.on('thought:shared', onShared);
    sock.on('thought:pinned', onPinned);
    sock.on('thought:unpinned', onUnpinned);
    sock.on('thought:updated', onUpdated);
    return () => {
      sock.off('thought:shared', onShared);
      sock.off('thought:pinned', onPinned);
      sock.off('thought:unpinned', onUnpinned);
      sock.off('thought:updated', onUpdated);
    };
  }, [conversationId, load]);

  const handleTogglePin = useCallback(async (t: Thought, isPinned: boolean) => {
    try {
      if (isPinned) {
        await unpinThought(t.id, conversationId);
      } else {
        await pinThought(t.id, conversationId);
      }
      await load(true);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Pin change failed');
    }
  }, [conversationId, load]);

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
    try {
      const updated = await updateThought(id, { text });
      setPinned((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      setFromChat((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save edit');
    }
  }, [editingId, editDraft]);

  const renderEditorCard = (value: string, onChange: (t: string) => void, onBlur: () => void, placeholder?: string) => (
    <View style={[styles.editorCard, { backgroundColor: c.surface, borderColor: c.border, borderLeftColor: c.primary }]}>
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

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={c.primary} />
        }
      >
        {error && (
          <Text style={[styles.error, { color: c.danger }]}>{error}</Text>
        )}

        <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Pinned</Text>
        {creating && renderEditorCard(newDraft, setNewDraft, () => void commitNew(), 'New pinned thought…')}
        {pinned.length === 0 && !loading && !creating && (
          <Text style={[styles.emptyText, { color: c.textMetadata }]}>
            Nothing pinned yet. Long-press a message and choose “Save & pin to
            chat”, or tap + to add one.
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
            />
          )
        )}

        <Text style={[styles.sectionTitle, { color: c.textSecondary, marginTop: 18 }]}>
          From this chat
        </Text>
        {fromChat.length === 0 && !loading && (
          <Text style={[styles.emptyText, { color: c.textMetadata }]}>
            Shared tags from this chat land here — use #fact, #idea, #todo… in a
            message, or long-press a message → “Save to Thoughts” for a private capture.
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
            />
          )
        )}
      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.primary }]}
        onPress={openAdd}
        activeOpacity={0.8}
      >
        <AppIcon name="plus" color={c.onPrimary} size={26} strokeWidth={2.2} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
