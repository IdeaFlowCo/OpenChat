/**
 * Chat thread — read messages, send, see typing indicator. The conversation
 * is identified by route param; we read the conversation metadata from the
 * context list so we stay in sync with rename / participant changes.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { useNavigation, useRoute } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Conversation, Message } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import type { NavProp, RouteProps } from '../navigation/types';
import { setActiveConversationForNotifications } from '../services/notifications';

const TYPING_DEBOUNCE_MS = 2000; // auto-clear typing after this much silence

function sameDay(a: string, b: string): boolean {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (sameDay(iso, today.toISOString())) return 'Today';
  if (sameDay(iso, yest.toISOString())) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface RenderRow {
  type: 'message' | 'day';
  key: string;
  message?: Message & { _failed?: boolean };
  label?: string;
  isOwn?: boolean;
  showSender?: boolean;
}

function buildRows(messages: Message[], myId: string | undefined): RenderRow[] {
  const out: RenderRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = messages[i - 1];
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
      out.push({ type: 'day', key: `day-${m.createdAt}`, label: dayLabel(m.createdAt) });
    }
    const isOwn = m.senderId === myId;
    const showSender = !isOwn && (!prev || prev.senderId !== m.senderId);
    out.push({ type: 'message', key: m.id, message: m as Message & { _failed?: boolean }, isOwn, showSender });
  }
  return out;
}

export function ChatScreen() {
  const navigation = useNavigation<NavProp<'Chat'>>();
  const route = useRoute<RouteProps<'Chat'>>();
  const { conversationId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  // Dynamic keyboard offset: nav-stack header + safe-area top inset. On iPhone
  // 14 this is ~44 + ~47 ≈ 91, which matches what the old hardcoded 90
  // approximated — but now it's device-correct (notched vs non-notched, large
  // text settings, modal vs root, etc.).
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const kbOffset = Platform.OS === 'ios' ? headerHeight + insets.top : 0;
  const {
    currentUser, conversations, messages, loadingMessages,
    setActiveConversation, sendMessage, presence, typingByConv, reportTyping,
  } = useChat();

  const conversation = useMemo<Conversation | undefined>(
    () => conversations.find(cv => cv.id === conversationId),
    [conversations, conversationId]
  );

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<RenderRow>>(null);
  const typingTimer = useRef<NodeJS.Timeout | null>(null);

  // Activate this conversation in context on mount; clear on unmount.
  // Also tell the notification service so it can suppress foreground banners
  // for messages arriving in the conversation the user is already viewing.
  useEffect(() => {
    setActiveConversation(conversationId);
    setActiveConversationForNotifications(conversationId);
    return () => {
      setActiveConversation(null);
      setActiveConversationForNotifications(null);
    };
  }, [conversationId, setActiveConversation]);

  const isGroup = conversation?.type === 'group';
  const other = !isGroup ? conversation?.participants?.find(p => p.user.id !== currentUser?.userId)?.user : null;
  const headerTitle = useMemo(() => {
    if (!conversation) return '';
    if (conversation.title) return conversation.title;
    if (!isGroup) return other?.name || other?.email || 'Chat';
    const others = (conversation.participants || [])
      .filter(p => p.user.id !== currentUser?.userId)
      .map(p => p.user.name || p.user.email?.split('@')[0] || '?');
    if (others.length === 0) return 'Group';
    if (others.length <= 2) return others.join(', ');
    return `${others[0]} +${others.length - 1}`;
  }, [conversation, isGroup, other, currentUser?.userId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <TouchableOpacity
          onPress={() => isGroup && navigation.navigate('GroupSettings', { conversationId })}
          disabled={!isGroup}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '80%' }}
        >
          <Avatar
            name={!isGroup ? (other?.name || other?.email) : headerTitle}
            email={other?.email}
            isBot={!isGroup ? other?.isBot : false}
            size={28}
          />
          <View style={{ flexShrink: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: c.textPrimary, fontWeight: '600', fontSize: 16 }} numberOfLines={1}>
                {headerTitle}
              </Text>
              {!isGroup && <BotBadge isBot={other?.isBot} compact />}
              {isGroup && (
                <Text style={{ color: c.textMuted, marginLeft: 4 }}>ⓘ</Text>
              )}
            </View>
            {!isGroup && other && (
              <Text style={{ color: c.textSecondary, fontSize: 11 }} numberOfLines={1}>
                {(presence.get(other.id)?.statusMessage) || presence.get(other.id)?.status || other.presenceStatus || ''}
              </Text>
            )}
            {isGroup && (
              <Text style={{ color: c.textSecondary, fontSize: 11 }} numberOfLines={1}>
                {(conversation?.participants?.length || 0)} members
              </Text>
            )}
          </View>
        </TouchableOpacity>
      ),
    });
  }, [navigation, isGroup, headerTitle, conversationId, conversation?.participants?.length, other, presence, c.textPrimary, c.textSecondary, c.textMuted]);

  const rows = useMemo(() => buildRows(messages, currentUser?.userId), [messages, currentUser?.userId]);

  // Scroll to bottom when new messages arrive (length grew) or first load.
  useEffect(() => {
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: messages.length > 1 }), 50);
    return () => clearTimeout(t);
  }, [messages.length]);

  const handleTextChange = (next: string) => {
    setText(next);
    // Typing throttle: emit typing:start on first keystroke, auto-stop after silence.
    if (next.length > 0) {
      reportTyping(conversationId, true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => reportTyping(conversationId, false), TYPING_DEBOUNCE_MS);
    } else {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      reportTyping(conversationId, false);
    }
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setText('');
    if (typingTimer.current) clearTimeout(typingTimer.current);
    reportTyping(conversationId, false);
    try {
      await sendMessage(trimmed);
    } catch (err) {
      // The context already tagged the optimistic message _failed=true.
      console.warn('[ChatScreen] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  // Typing indicator (someone else)
  const otherTypers = useMemo(() => {
    const set = typingByConv.get(conversationId);
    if (!set) return [];
    return Array.from(set).filter(uid => uid !== currentUser?.userId);
  }, [typingByConv, conversationId, currentUser?.userId]);

  const typingLabel = useMemo(() => {
    if (otherTypers.length === 0) return '';
    if (!conversation) return 'typing…';
    const names = otherTypers
      .map(uid => conversation.participants?.find(p => p.user.id === uid)?.user)
      .filter(Boolean)
      .map(u => (u!.name || u!.email?.split('@')[0] || '?'));
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return `${names.length} people are typing…`;
  }, [otherTypers, conversation]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
      keyboardVerticalOffset={kbOffset}
    >
      {loadingMessages && messages.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={r => r.key}
          contentContainerStyle={{ padding: 12, gap: 6 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            if (item.type === 'day') {
              return (
                <View style={styles.dayWrap}>
                  <View style={[styles.dayLine, { backgroundColor: c.divider }]} />
                  <Text style={[styles.dayLabel, { color: c.textMuted }]}>{item.label}</Text>
                  <View style={[styles.dayLine, { backgroundColor: c.divider }]} />
                </View>
              );
            }
            const m = item.message!;
            const isOwn = !!item.isOwn;
            const failed = !!m._failed;
            return (
              <View style={[styles.row, { justifyContent: isOwn ? 'flex-end' : 'flex-start' }]}>
                <View
                  style={[
                    styles.bubble,
                    {
                      backgroundColor: failed ? c.dangerMuted : (isOwn ? c.bubbleOwn : c.bubbleOther),
                      borderBottomRightRadius: isOwn ? 4 : 18,
                      borderBottomLeftRadius: isOwn ? 18 : 4,
                      borderColor: failed ? c.danger : 'transparent',
                      borderWidth: failed ? 1 : 0,
                    },
                  ]}
                >
                  {item.showSender && m.sender && (
                    <Text style={[styles.sender, { color: c.textSecondary }]}>
                      {m.sender.name || m.sender.email}
                    </Text>
                  )}
                  <Text style={{ color: isOwn ? c.bubbleOwnText : c.bubbleOtherText, fontSize: 16 }}>
                    {m.content}
                  </Text>
                  <View style={styles.bubbleFooter}>
                    <Text style={{ color: isOwn ? 'rgba(255,255,255,0.7)' : c.textMuted, fontSize: 10 }}>
                      {failed ? 'Failed to send' : formatTime(m.createdAt)}
                    </Text>
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      {!!typingLabel && (
        <View style={[styles.typingBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={{ color: c.textSecondary, fontSize: 12 }}>{typingLabel}</Text>
        </View>
      )}

      <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]}
          value={text}
          onChangeText={handleTextChange}
          placeholder="Type a message…"
          placeholderTextColor={c.textMuted}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, { backgroundColor: c.primary, opacity: !text.trim() || sending ? 0.5 : 1 }]}
          onPress={handleSend}
          disabled={!text.trim() || sending}
          accessibilityLabel="Send message"
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  sender: { fontSize: 12, marginBottom: 2, fontWeight: '500' },
  bubbleFooter: { marginTop: 4 },
  dayWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dayLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.4 },
  typingBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 40,
    maxHeight: 120,
  },
  send: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
