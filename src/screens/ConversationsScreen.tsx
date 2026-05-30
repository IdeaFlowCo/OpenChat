import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import { api, Conversation, getUser, clearSession, CurrentUser } from '../api/client';
import { connect, disconnect, getSocket } from '../api/socket';
import { getColors } from '../theme/colors';

interface Props {
  onOpenConversation: (conv: Conversation) => void;
  onSignedOut: () => void;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return 'now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
  return d.toLocaleDateString();
}

function getDisplayTitle(conv: Conversation, me: CurrentUser | null): string {
  if (conv.title) return conv.title;
  if (conv.type === 'direct') {
    const other = conv.participants?.find((p) => p.user.id !== me?.userId)?.user;
    return other?.name || other?.email || 'Unknown';
  }
  return 'Group Chat';
}

export function ConversationsScreen({ onOpenConversation, onSignedOut }: Props) {
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getConversations();
      setConversations(sortByRecent(data));
    } catch (err) {
      console.warn('Failed to load conversations:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMe(await getUser());
      try {
        const sock = await connect();
        if (cancelled) return;
        sock.on('connect', () => setConnected(true));
        sock.on('disconnect', () => setConnected(false));
        sock.on('message:new', (msg) => {
          setConversations((prev) => sortByRecent(prev.map((conv) =>
            conv.id === msg.conversationId
              ? { ...conv, lastMessagePreview: msg.content.slice(0, 100), lastMessageAt: msg.createdAt }
              : conv
          )));
        });
      } catch (e) {
        console.warn('Socket connect failed:', e);
      }
      load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleSignOut = async () => {
    disconnect();
    await clearSession();
    onSignedOut();
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.surface }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: c.textPrimary }]}>Chats</Text>
          <Text style={[styles.subtitle, { color: c.textSecondary }]}>
            {me?.email} · {connected ? '🟢 connected' : '⚪ connecting…'}
          </Text>
        </View>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={{ color: c.danger, fontSize: 14, fontWeight: '500' }}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={c.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={{ color: c.textSecondary, marginTop: 32 }}>No conversations yet</Text>
          </View>
        }
        renderItem={({ item }) => {
          const title = getDisplayTitle(item, me);
          return (
            <TouchableOpacity
              style={[styles.row, { borderColor: c.divider }]}
              onPress={() => onOpenConversation(item)}
              activeOpacity={0.7}
            >
              <View style={[styles.avatar, { backgroundColor: c.surfaceElevated }]}>
                <Text style={{ color: c.textSecondary, fontWeight: '600' }}>
                  {title.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={[styles.rowTitle, { color: c.textPrimary }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={[styles.rowTime, { color: c.textMuted }]}>
                    {formatTime(item.lastMessageAt)}
                  </Text>
                </View>
                {item.lastMessagePreview && (
                  <Text style={[styles.rowPreview, { color: c.textSecondary }]} numberOfLines={1}>
                    {item.lastMessagePreview}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

function sortByRecent(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    const aT = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bT = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bT - aT;
  });
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowTitle: { fontSize: 16, fontWeight: '600', flex: 1 },
  rowTime: { fontSize: 12 },
  rowPreview: { fontSize: 14, marginTop: 2 },
});
