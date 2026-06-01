/**
 * ChatPane — the message thread body, factored out of ChatScreen so the
 * desktop master-detail layout can render it directly in the right pane.
 *
 * Differences from the old ChatScreen body:
 *   - Takes conversationId as a prop (not a route param)
 *   - Takes optional onOpenGroupSettings + showInlineHeader props so the
 *     parent can choose whether to render its own header (desktop) or let
 *     us render the inline header (used when there's no nav header).
 *   - ESC / Enter / Shift-Enter handling on web (keyboard shortcuts only
 *     active when the composer is focused for Enter; ESC is documented at
 *     the parent layout level).
 *
 * ChatScreen still wraps this for narrow / stack-mode use and continues to
 * own its native-stack header via navigation.setOptions.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputKeyPressEventData,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { Conversation, Message } from '../api/client';
import { getColors } from '../theme/colors';
import { Avatar } from './Avatar';
import { BotBadge } from './BotBadge';
import { NewMessagesPill } from './NewMessagesPill';
import { MAX_CONTENT_WIDTH } from './MaxWidthContent';
import { setActiveConversationForNotifications } from '../services/notifications';
import { colorForUserId } from '../utils/colorForUserId';

const TYPING_DEBOUNCE_MS = 2000;

// Distance from the bottom (in px) within which we consider the user to be
// "at bottom" — i.e. they want to see new messages as they arrive. Beyond
// this, they're reading history and we shouldn't yank their scroll.
const AT_BOTTOM_THRESHOLD_PX = 100;

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
  /** First message of a run from this author (after a different author / day break). */
  showSender?: boolean;
  /** Last message of a run from this author (next message is different author / day / EOF).
   *  Used to render the avatar only on the bottom of a run in group chats. */
  isLastInRun?: boolean;
}

function buildRows(messages: Message[], myId: string | undefined): RenderRow[] {
  const out: RenderRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
      out.push({ type: 'day', key: `day-${m.createdAt}`, label: dayLabel(m.createdAt) });
    }
    const isOwn = m.senderId === myId;
    const showSender = !isOwn && (!prev || prev.senderId !== m.senderId);
    // "Last in run" = there is no next message, or the next is a different
    // author, or there's a day break between them. We pin the avatar here so
    // consecutive bubbles from the same author don't repeat the avatar.
    const isLastInRun = !next
      || next.senderId !== m.senderId
      || !sameDay(m.createdAt, next.createdAt);
    out.push({
      type: 'message',
      key: m.id,
      message: m as Message & { _failed?: boolean },
      isOwn,
      showSender,
      isLastInRun,
    });
  }
  return out;
}

export interface ChatPaneProps {
  conversationId: string;
  /** When provided, the pane renders an inline top header (avatar + title + members count).
   * Use when there's no native-stack header above (i.e. desktop master-detail). */
  showInlineHeader?: boolean;
  /** Callback invoked when the user clicks the group header. Only used when showInlineHeader. */
  onOpenGroupSettings?: (conversationId: string) => void;
}

export function ChatPane({ conversationId, showInlineHeader, onOpenGroupSettings }: ChatPaneProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
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
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Scroll behavior ────────────────────────────────────────────────────────
  // We track "is the user near the bottom?" both as a ref (for synchronous
  // reads inside onScroll / the messages effect, without re-creating handlers
  // each render) AND as a state (so the NewMessagesPill can react). The ref
  // is the source of truth for decisions; the state is for rendering only.
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  // Tracks message count from the previous render so we can detect grew-by-N.
  const prevLenRef = useRef(0);
  // Initial-mount / conversation-switch flag: first scroll should be
  // non-animated, and we should not count "new" messages as unread.
  const initialScrollDoneRef = useRef(false);

  // Activate this conversation in context on mount; clear on unmount/switch.
  useEffect(() => {
    setActiveConversation(conversationId);
    setActiveConversationForNotifications(conversationId);
    // Reset scroll bookkeeping whenever the conversation changes — opening
    // a fresh thread should start "at bottom" with no unread badge, regardless
    // of where we were in the previous thread.
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setUnreadCount(0);
    prevLenRef.current = 0;
    initialScrollDoneRef.current = false;
    return () => {
      // We only null these out if this pane is *unmounting*. In the desktop
      // case, switching conversationId remounts the pane via key=, so cleanup
      // still fires per-conversation as expected.
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

  const rows = useMemo(() => buildRows(messages, currentUser?.userId), [messages, currentUser?.userId]);

  // At-bottom-aware scroll. Rules:
  //   R7. Initial mount / conversation switch → jump to bottom, no animation.
  //   R6. Own message just sent → always scroll to bottom (we know the user
  //       wants to see what they sent).
  //   R2. Otherwise, if the user was at the bottom → animated scrollToEnd.
  //       If they were reading history → leave their scroll alone and bump
  //       the unread count instead (R4 surfaces the pill).
  // We read isAtBottomRef.current — that reflects the state BEFORE the new
  // message arrived, which is exactly the signal we want.
  useEffect(() => {
    const len = messages.length;
    const prevLen = prevLenRef.current;
    prevLenRef.current = len;
    if (len === 0) return;

    // First render with messages → snap to bottom, no animation, no unread.
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      return () => clearTimeout(t);
    }

    if (len <= prevLen) return; // message deleted / no growth — do nothing
    const grew = len - prevLen;
    const latest = messages[len - 1];
    const isOwn = latest?.senderId === currentUser?.userId;

    if (isOwn || isAtBottomRef.current) {
      const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
      return () => clearTimeout(t);
    }

    // User is reading history — bump unread by however many messages arrived
    // in this batch (typically 1, but websocket can deliver bursts).
    setUnreadCount(c => c + grew);
  }, [messages, currentUser?.userId]);

  // R3. Manual scroll handler — compute distance-from-bottom and update both
  // the ref (synchronous, used by the messages effect above) and state (for
  // the pill render). Reset unread when the user returns to the bottom.
  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - contentOffset.y - layoutMeasurement.height;
    const atBottom = distanceFromBottom < AT_BOTTOM_THRESHOLD_PX;
    const wasAtBottom = isAtBottomRef.current;
    isAtBottomRef.current = atBottom;
    if (atBottom !== wasAtBottom) setIsAtBottom(atBottom);
    if (atBottom && !wasAtBottom) setUnreadCount(0);
  };

  // R5. Pill tap → scroll to latest. onScroll will fire as the scroll
  // animates and naturally flip isAtBottom + clear unreadCount.
  const handlePillPress = () => {
    listRef.current?.scrollToEnd({ animated: true });
  };

  // Keyboard show: when iOS keyboard pushes the composer up, the visible
  // area of the list shrinks. If the user WAS at the bottom, they should
  // stay pinned there after the layout settles. (If they were reading
  // history, leave them alone.)
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (isAtBottomRef.current) {
        // Defer past the layout animation so contentSize reflects the new
        // (smaller) layout before we scroll.
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      }
    });
    return () => sub.remove();
  }, []);

  const handleTextChange = (next: string) => {
    setText(next);
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
      console.warn('[ChatPane] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  // Web: Enter sends, Shift-Enter newlines. Native: leave as default
  // (multiline input). The synthetic event on web exposes the native event,
  // which we use to read shiftKey.
  const handleKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (Platform.OS !== 'web') return;
    const native: any = (e as any).nativeEvent;
    if (native?.key === 'Enter' && !native?.shiftKey) {
      e.preventDefault?.();
      void handleSend();
    }
  };

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
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {showInlineHeader && (
        <Pressable
          onPress={() => isGroup && onOpenGroupSettings?.(conversationId)}
          disabled={!isGroup}
          style={[styles.inlineHeader, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <Avatar
            name={!isGroup ? (other?.name || other?.email) : headerTitle}
            email={other?.email}
            isBot={!isGroup ? other?.isBot : false}
            size={36}
          />
          <View style={{ flexShrink: 1, flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: c.textPrimary, fontWeight: '600', fontSize: 16 }} numberOfLines={1}>
                {headerTitle}
              </Text>
              {!isGroup && <BotBadge isBot={other?.isBot} compact />}
              {isGroup && (
                <Text
                  style={{ color: c.textMuted, marginLeft: 4 }}
                  // @ts-ignore — title is a web-only DOM attr
                  title="Group info"
                >
                  ⓘ
                </Text>
              )}
            </View>
            {!isGroup && other && (
              <Text style={{ color: c.textSecondary, fontSize: 11 }} numberOfLines={1}>
                {(presence.get(other.id)?.statusMessage) || presence.get(other.id)?.status || other.presenceStatus || ''}
              </Text>
            )}
            {isGroup && (
              <Text
                style={{ color: c.textSecondary, fontSize: 11 }}
                numberOfLines={1}
                // @ts-ignore — title is a web-only DOM attr
                title={`${(conversation?.participants?.length || 0)} members`}
              >
                {(conversation?.participants?.length || 0)} members
              </Text>
            )}
          </View>
        </Pressable>
      )}

      {loadingMessages && messages.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        // Wrap the list + floating pill in a flex:1 relative container so the
        // pill's absolute positioning is anchored to the message-area bottom
        // (i.e. just above the composer), not to the whole KeyboardAvoidingView.
        <View style={styles.listWrap}>
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={r => r.key}
            // Cap message column at ~720px and center it. On phones/tablets the
            // maxWidth never binds; on a 1920px monitor this gives ~600px of
            // gutter total and keeps line-length comfortable.
            contentContainerStyle={{ padding: 12, gap: 6, maxWidth: MAX_CONTENT_WIDTH, width: '100%', alignSelf: 'center' }}
            onScroll={handleScroll}
            // Throttle scroll events to ~60fps; high enough to catch the
            // user reaching bottom quickly, low enough not to thrash JS.
            scrollEventThrottle={16}
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
              // WhatsApp-style identification for group chats: colored sender
              // name on the first message of a run, small avatar on the LAST
              // message of a run. We still reserve the avatar slot on the
              // non-last messages so the bubbles stay vertically aligned.
              const showGroupAvatar = isGroup && !isOwn;
              const senderColor = colorForUserId(m.senderId, scheme);
              return (
                <View style={[styles.row, { justifyContent: isOwn ? 'flex-end' : 'flex-start', alignItems: 'flex-end' }]}>
                  {showGroupAvatar && (
                    <View style={styles.avatarSlot}>
                      {item.isLastInRun && (
                        <Avatar
                          name={m.sender?.name}
                          email={m.sender?.email}
                          size={28}
                        />
                      )}
                    </View>
                  )}
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
                      <Text style={[
                        styles.sender,
                        { color: isGroup ? senderColor : c.textSecondary },
                      ]}>
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
          {unreadCount > 0 && !isAtBottom && (
            <NewMessagesPill count={unreadCount} onPress={handlePillPress} />
          )}
        </View>
      )}

      {!!typingLabel && (
        <View style={[styles.typingBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.maxWidthInner}>
            <Text style={{ color: c.textSecondary, fontSize: 12 }}>{typingLabel}</Text>
          </View>
        </View>
      )}

      <View style={[styles.composerBar, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.composer, styles.maxWidthInner]}>
          <TextInput
            style={[styles.input, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]}
            value={text}
            onChangeText={handleTextChange}
            onKeyPress={handleKeyPress}
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
      </View>
    </KeyboardAvoidingView>
  );
}

/** Re-export the layoutEffect helper so ChatScreen can build its native-stack
 * header using the same title/avatar logic. Kept thin on purpose. */
export function useChatHeader(conversationId: string) {
  const { currentUser, conversations, presence } = useChat();
  const conversation = useMemo(
    () => conversations.find(cv => cv.id === conversationId),
    [conversations, conversationId]
  );
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
  return { conversation, isGroup, other, headerTitle, presence };
}

// Suppress 'unused' on useLayoutEffect import in case future refactors need it.
void useLayoutEffect;

const styles = StyleSheet.create({
  root: { flex: 1 },
  listWrap: { flex: 1, position: 'relative' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: 6 },
  // Fixed-width slot so bubbles stay vertically aligned regardless of whether
  // the avatar is rendered on this row of the run.
  avatarSlot: { width: 28, alignItems: 'center', justifyContent: 'flex-end' },
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
  inlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Bar spans the full pane width (so the border + background fill the pane)
  // but the inner composer content is capped at MAX_CONTENT_WIDTH so the
  // input + Send button align with the message column above.
  composerBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  maxWidthInner: {
    maxWidth: MAX_CONTENT_WIDTH,
    width: '100%',
    alignSelf: 'center',
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
