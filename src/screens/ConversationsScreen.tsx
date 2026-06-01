/**
 * Conversation list — the home screen once signed in.
 *
 * Now driven entirely by ChatContext (no per-screen socket subscriptions).
 * Adds a compose button in the header, unread pills, presence dots, and a
 * bot badge for DMs whose other party is a bot.
 *
 * Reconnect catch-up (OpenChat-qz0): rows that received new messages during
 * a reconnect catch-up briefly pulse with a highlight background.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { useNavigation } from '@react-navigation/native';
import { Conversation, CurrentUser } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import type { NavProp } from '../navigation/types';

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return d.toLocaleDateString();
}

function getOther(conv: Conversation, me: CurrentUser | null) {
  return conv.participants?.find(p => p.user.id !== me?.userId)?.user;
}

function getDisplayTitle(conv: Conversation, me: CurrentUser | null): string {
  if (conv.title) return conv.title;
  if (conv.type === 'direct') {
    const other = getOther(conv, me);
    return other?.name || other?.email || 'Unknown';
  }
  // Group fallback: list first 2 other-participant names.
  const others = (conv.participants || [])
    .filter(p => p.user.id !== me?.userId)
    .map(p => p.user.name || p.user.email?.split('@')[0] || '?');
  if (others.length === 0) return 'Group';
  if (others.length <= 2) return others.join(', ');
  return `${others[0]}, ${others[1]} +${others.length - 2}`;
}

// ── ConvRow ───────────────────────────────────────────────────────────────────
// Renders a single conversation row. When `pulseIn` flips to true, runs a
// brief opacity flash to indicate that new messages arrived during reconnect.
interface ConvRowProps {
  item: Conversation;
  currentUser: CurrentUser | null;
  unread: number;
  isMuted: boolean;
  someoneTyping: boolean;
  presenceStatus?: string;
  isBot?: boolean;
  pulseIn: boolean;
  primaryColor: string;
  dividerColor: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  onPress: () => void;
}

function ConvRow({
  item, currentUser, unread, isMuted, someoneTyping,
  presenceStatus, isBot, pulseIn,
  primaryColor, dividerColor, textPrimary, textSecondary, textMuted,
  onPress,
}: ConvRowProps) {
  const title = getDisplayTitle(item, currentUser);
  const other = item.type === 'direct' ? getOther(item, currentUser) : null;
  const bgAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulseIn) return;
    // Flash: fade to highlight then fade out.
    Animated.sequence([
      Animated.timing(bgAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(bgAnim, { toValue: 0, duration: 1800, useNativeDriver: true }),
    ]).start();
  }, [pulseIn, bgAnim]);

  return (
    <View>
      {/* Highlight overlay (sits behind the row content) */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: primaryColor,
            opacity: bgAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.12] }),
          },
        ]}
        pointerEvents="none"
      />
      <TouchableOpacity
        style={[styles.row, { borderColor: dividerColor }]}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <Avatar
          name={item.type === 'direct' ? (other?.name || other?.email) : title}
          email={other?.email}
          isBot={isBot}
          presenceStatus={item.type === 'direct' ? presenceStatus : undefined}
          size={48}
        />
        <View style={{ flex: 1 }}>
          <View style={styles.rowTop}>
            <View style={styles.titleRow}>
              <Text
                style={[
                  styles.rowTitle,
                  { color: textPrimary, fontWeight: unread > 0 ? '700' : '600' },
                ]}
                numberOfLines={1}
              >
                {title}
              </Text>
              {item.type === 'direct' && <BotBadge isBot={isBot} compact />}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {isMuted && (
                <Text style={{ fontSize: 11, color: textMuted }}>🔕</Text>
              )}
              <Text style={[styles.rowTime, { color: textMuted }]}>
                {formatTime(item.lastMessageAt)}
              </Text>
            </View>
          </View>
          <View style={styles.previewRow}>
            <Text
              style={[
                styles.rowPreview,
                { color: unread > 0 ? textPrimary : textSecondary, fontWeight: unread > 0 ? '500' : '400' },
              ]}
              numberOfLines={1}
            >
              {someoneTyping ? 'typing…' : (item.lastMessagePreview || (item.type === 'group' ? 'Group conversation' : ''))}
            </Text>
            {unread > 0 && (
              <View style={[styles.unreadPill, { backgroundColor: primaryColor }]}>
                <Text style={styles.unreadPillText}>{unread > 99 ? '99+' : String(unread)}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

export function ConversationsScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'Conversations'>>();
  const {
    currentUser, conversations, conversationsLoaded, refreshConversations,
    isConnected, presence, unreadByConv, typingByConv, signOut, mutedConvs,
    reconnectNewConvIds,
  } = useChat();
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: c.textPrimary }}>Chats</Text>
          <Text style={{ fontSize: 11, color: c.textSecondary }}>
            {currentUser?.email}  ·  {isConnected ? '🟢 connected' : '⚪ offline — reconnecting'}
          </Text>
        </View>
      ),
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => navigation.navigate('Search')}
            accessibilityLabel="Search"
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ color: c.primary, fontSize: 20 }}>🔍</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('NewConversation')}
            accessibilityLabel="New conversation"
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ color: c.primary, fontSize: 28, lineHeight: 28, fontWeight: '300' }}>＋</Text>
          </TouchableOpacity>
        </View>
      ),
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => navigation.navigate('Settings')}
          accessibilityLabel="Settings"
          style={{ paddingHorizontal: 8, paddingVertical: 4 }}
        >
          <Text style={{ color: c.primary, fontSize: 20 }}>⚙︎</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, c.primary, c.danger, c.textPrimary, c.textSecondary, currentUser?.email, isConnected, signOut]);

  useEffect(() => {
    if (!conversationsLoaded) refreshConversations();
  }, [conversationsLoaded, refreshConversations]);

  if (!conversationsLoaded) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <FlatList
        data={conversations}
        keyExtractor={item => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refreshConversations();
              setRefreshing(false);
            }}
            tintColor={c.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: c.textPrimary, fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
              No chats yet
            </Text>
            <Text style={{ color: c.textSecondary, textAlign: 'center', paddingHorizontal: 32 }}>
              Tap ＋ in the top-right to start a direct message or create a group.
            </Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('NewConversation')}
              style={[styles.emptyBtn, { backgroundColor: c.primary }]}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>Start a chat</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => {
          const other = item.type === 'direct' ? getOther(item, currentUser) : null;
          const unread = unreadByConv.get(item.id) ?? 0;
          const live = other ? presence.get(other.id) : null;
          const typingSet = typingByConv.get(item.id);
          const someoneTyping = typingSet != null && typingSet.size > 0
            && Array.from(typingSet).some(uid => uid !== currentUser?.userId);
          const mutedUntil = mutedConvs[item.id];
          const isMuted = mutedUntil === 'always' || (!!mutedUntil && new Date(mutedUntil) > new Date());
          const pulseIn = reconnectNewConvIds.has(item.id);
          return (
            <ConvRow
              item={item}
              currentUser={currentUser}
              unread={unread}
              isMuted={isMuted}
              someoneTyping={someoneTyping}
              presenceStatus={live?.status || other?.presenceStatus}
              isBot={other?.isBot}
              pulseIn={pulseIn}
              primaryColor={c.primary}
              dividerColor={c.divider}
              textPrimary={c.textPrimary}
              textSecondary={c.textSecondary}
              textMuted={c.textMuted}
              onPress={() => navigation.navigate('Chat', { conversationId: item.id })}
            />
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  rowTitle: { fontSize: 16, flexShrink: 1 },
  rowTime: { fontSize: 12 },
  previewRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 8 },
  rowPreview: { fontSize: 14, flex: 1 },
  unreadPill: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadPillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
});
