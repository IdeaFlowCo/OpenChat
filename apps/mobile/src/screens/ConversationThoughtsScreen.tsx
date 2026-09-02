/**
 * ConversationThoughtsScreen — chat-scoped Thoughts view.
 *
 * Opened from a chat's header (thought-bubble icon). Shows two sections:
 *   Pinned          — thoughts pinned to this conversation by any participant
 *                     (pinning shares the thought with the whole chat)
 *   From this chat  — the caller's own thoughts captured from this chat
 *                     (#hashtag captures + "Save to Thoughts")
 *
 * Pin toggles: own thoughts can be pinned/unpinned; another participant's
 * pinned thought can't be modified here. Long-press deletes own thoughts.
 * Live updates via 'thought:pinned' / 'thought:unpinned' socket events.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useChat } from '../contexts/ChatContext';
import {
  fetchConversationThoughts,
  pinThought,
  unpinThought,
  deleteThought,
  Thought,
} from '../services/thoughts';
import { getSocket } from '../api/socket';
import { ThoughtCard } from '../components/ThoughtCard';
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

  // Live pin/unpin updates from other participants.
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onPinned = (p: { conversationId: string; thought: Thought }) => {
      if (p?.conversationId !== conversationId || !p.thought) return;
      setPinned((prev) =>
        prev.some((t) => t.id === p.thought.id) ? prev : [p.thought, ...prev]
      );
      setFromChat((prev) => prev.filter((t) => t.id !== p.thought.id));
    };
    const onUnpinned = (p: { conversationId: string; thoughtId: string }) => {
      if (p?.conversationId !== conversationId) return;
      setPinned((prev) => prev.filter((t) => t.id !== p.thoughtId));
      // The thought may still belong in "From this chat" — just refetch.
      void load(true);
    };
    sock.on('thought:pinned', onPinned);
    sock.on('thought:unpinned', onUnpinned);
    return () => {
      sock.off('thought:pinned', onPinned);
      sock.off('thought:unpinned', onUnpinned);
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

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: c.background }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={c.primary} />
      }
    >
      {error && (
        <Text style={[styles.error, { color: c.danger }]}>{error}</Text>
      )}

      <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>Pinned</Text>
      {pinned.length === 0 && !loading && (
        <Text style={[styles.emptyText, { color: c.textMuted }]}>
          Nothing pinned yet. Long-press a message and choose “Save & pin to
          chat”, or pin one of your thoughts below.
        </Text>
      )}
      {pinned.map((t) => (
        <ThoughtCard
          key={t.id}
          item={{ ...t, pinned: true }}
          subtitle={
            mine(t)
              ? 'pinned by you'
              : `by ${t.authorName || 'a participant'}`
          }
          onDelete={mine(t) ? () => handleDelete(t.id) : undefined}
          onTogglePin={
            mine(t) || t.pinnedBy === myId
              ? () => handleTogglePin(t, true)
              : undefined
          }
        />
      ))}

      <Text style={[styles.sectionTitle, { color: c.textSecondary, marginTop: 18 }]}>
        From this chat
      </Text>
      {fromChat.length === 0 && !loading && (
        <Text style={[styles.emptyText, { color: c.textMuted }]}>
          Your thoughts captured from this chat land here — use #fact, #idea,
          #todo… in a message, or long-press a message → “Save to Thoughts”.
        </Text>
      )}
      {fromChat.map((t) => (
        <ThoughtCard
          key={t.id}
          item={{ ...t, pinned: false }}
          onDelete={() => handleDelete(t.id)}
          onTogglePin={() => handleTogglePin(t, false)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, paddingBottom: 48 },
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
});
