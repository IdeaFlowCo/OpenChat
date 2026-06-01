/**
 * ConversationList — the list-of-conversations body, factored out so it can
 * be reused by:
 *   - ConversationsScreen (narrow / stack-mode navigation)
 *   - MasterDetailLayout (desktop / side-by-side mode)
 *
 * The renderer is identical in both contexts; the only thing that changes
 * is what happens on press:
 *   - narrow: navigate('Chat', ...) — pushes a Chat screen
 *   - desktop: setActiveConversation(id) — swaps the right pane
 *
 * Hover affordances are wired here (Pressable + onHoverIn/onHoverOut) and
 * are a no-op on native, where pointer events don't fire. We also highlight
 * the active row when an activeId is provided (desktop only — narrow mode
 * passes undefined so no row is "active").
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Conversation, CurrentUser } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from './Avatar';
import { BotBadge } from './BotBadge';

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
  const others = (conv.participants || [])
    .filter(p => p.user.id !== me?.userId)
    .map(p => p.user.name || p.user.email?.split('@')[0] || '?');
  if (others.length === 0) return 'Group';
  if (others.length <= 2) return others.join(', ');
  return `${others[0]}, ${others[1]} +${others.length - 2}`;
}

interface RowProps {
  item: Conversation;
  isActive: boolean;
  onPress: () => void;
  /** Compact (collapsed-sidebar) mode: render avatar + unread badge only, no
   * name/preview text. On web we add a `title` attr for native hover tooltip. */
  compact?: boolean;
}

function ConversationRow({ item, isActive, onPress, compact }: RowProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser, presence, unreadByConv, typingByConv } = useChat();
  const [hovered, setHovered] = useState(false);

  const title = getDisplayTitle(item, currentUser);
  const other = item.type === 'direct' ? getOther(item, currentUser) : null;
  const unread = unreadByConv.get(item.id) ?? 0;
  const live = other ? presence.get(other.id) : null;
  const typingSet = typingByConv.get(item.id);
  const someoneTyping = typingSet && typingSet.size > 0
    && Array.from(typingSet).some(uid => uid !== currentUser?.userId);

  // Background priority: active > hover > default
  const rowBg = isActive
    ? c.bubbleOther
    : hovered
      ? c.surfaceElevated
      : 'transparent';

  if (compact) {
    return (
      <Pressable
        onPress={onPress}
        onHoverIn={Platform.OS === 'web' ? () => setHovered(true) : undefined}
        onHoverOut={Platform.OS === 'web' ? () => setHovered(false) : undefined}
        // @ts-ignore — title is a web-only DOM attr; passes through on RN-web
        title={title}
        style={[styles.compactRow, { backgroundColor: rowBg }]}
        accessibilityLabel={title}
      >
        <View>
          <Avatar
            name={item.type === 'direct' ? (other?.name || other?.email) : title}
            email={other?.email}
            isBot={other?.isBot}
            presenceStatus={item.type === 'direct' ? (live?.status || other?.presenceStatus) : undefined}
            size={36}
          />
          {unread > 0 && (
            <View style={[styles.compactUnread, { backgroundColor: c.primary, borderColor: c.surface }]}>
              <Text style={styles.unreadPillText}>{unread > 9 ? '9+' : String(unread)}</Text>
            </View>
          )}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={Platform.OS === 'web' ? () => setHovered(true) : undefined}
      onHoverOut={Platform.OS === 'web' ? () => setHovered(false) : undefined}
      style={[styles.row, { borderColor: c.divider, backgroundColor: rowBg }]}
    >
      <Avatar
        name={item.type === 'direct' ? (other?.name || other?.email) : title}
        email={other?.email}
        isBot={other?.isBot}
        presenceStatus={item.type === 'direct' ? (live?.status || other?.presenceStatus) : undefined}
        size={48}
      />
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <View style={styles.titleRow}>
            <Text
              style={[
                styles.rowTitle,
                { color: c.textPrimary, fontWeight: unread > 0 ? '700' : '600' },
              ]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {item.type === 'direct' && <BotBadge isBot={other?.isBot} compact />}
          </View>
          <Text style={[styles.rowTime, { color: c.textMuted }]}>
            {formatTime(item.lastMessageAt)}
          </Text>
        </View>
        <View style={styles.previewRow}>
          <Text
            style={[
              styles.rowPreview,
              { color: unread > 0 ? c.textPrimary : c.textSecondary, fontWeight: unread > 0 ? '500' : '400' },
            ]}
            numberOfLines={1}
          >
            {someoneTyping ? 'typing…' : (item.lastMessagePreview || (item.type === 'group' ? 'Group conversation' : ''))}
          </Text>
          {unread > 0 && (
            <View style={[styles.unreadPill, { backgroundColor: c.primary }]}>
              <Text style={styles.unreadPillText}>{unread > 99 ? '99+' : String(unread)}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export interface ConversationListProps {
  /** Conversation id to highlight as active (desktop only). Undefined in narrow mode. */
  activeId?: string | null;
  /** Called when a row is pressed. */
  onSelect: (conversationId: string) => void;
  /** Rendered above the list when the list is empty. Receives a "start new chat" callback. */
  onStartChat?: () => void;
  /** When true, rows render avatar + unread badge only (used by collapsed sidebar). */
  compact?: boolean;
}

export function ConversationList({ activeId, onSelect, onStartChat, compact }: ConversationListProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { conversations, conversationsLoaded, refreshConversations } = useChat();
  const [refreshing, setRefreshing] = useState(false);

  if (!conversationsLoaded) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: c.background }}
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
        compact ? (
          <View />
        ) : (
          <View style={styles.empty}>
            <Text style={{ color: c.textPrimary, fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
              No chats yet
            </Text>
            <Text style={{ color: c.textSecondary, textAlign: 'center', paddingHorizontal: 32 }}>
              Tap ＋ in the top-right to start a direct message or create a group.
            </Text>
            {onStartChat && (
              <Pressable
                onPress={onStartChat}
                style={[styles.emptyBtn, { backgroundColor: c.primary }]}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Start a chat</Text>
              </Pressable>
            )}
          </View>
        )
      }
      renderItem={({ item }) => (
        <ConversationRow
          item={item}
          isActive={activeId === item.id}
          onPress={() => onSelect(item.id)}
          compact={compact}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
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
  compactRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  compactUnread: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
});
