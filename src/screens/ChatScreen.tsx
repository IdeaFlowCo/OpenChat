/**
 * Chat thread — read messages, send, see typing indicator. The conversation
 * is identified by route param; we read the conversation metadata from the
 * context list so we stay in sync with rename / participant changes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
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
import { Conversation, Message, api } from '../api/client';
import { MessageActionSheet, ReplyToData } from '../components/MessageActionSheet';
import { ToastMessage } from '../components/ToastMessage';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { AiDisclosureBanner } from '../components/AiDisclosureBanner';
import { BotBadge } from '../components/BotBadge';
import { NewMessagesPill } from '../components/NewMessagesPill';
import { ChatEmptyState } from '../components/ChatEmptyState';
import type { NavProp, RouteProps } from '../navigation/types';
import { setActiveConversationForNotifications } from '../services/notifications';
import { hapticSend, hapticReceive } from '../services/haptics';
import { colorForUserId } from '../utils/colorForUserId';

const TYPING_DEBOUNCE_MS = 2000; // auto-clear typing after this much silence

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

export function ChatScreen() {
  const navigation = useNavigation<NavProp<'Chat'>>();
  const route = useRoute<RouteProps<'Chat'>>();
  const { conversationId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  // Dynamic keyboard offset for KeyboardAvoidingView. This is the distance
  // from the top of the screen to the top of the KAV — i.e. the height of
  // the nav-stack header. `useHeaderHeight()` already INCLUDES the safe-area
  // top inset on notched devices; adding insets.top on top of it double-counts
  // (~47px on iPhone 14), causing KAV to overestimate keyboard intrusion and
  // leave an empty gap below the composer when the keyboard opens.
  const headerHeight = useHeaderHeight();
  const kbOffset = Platform.OS === 'ios' ? headerHeight : 0;
  const {
    currentUser, conversations, messages, loadingMessages,
    setActiveConversation, sendMessage, presence, typingByConv, reportTyping,
    aiDisclosureAcceptedAt, mutedConvs, muteConv, blockUser,
  } = useChat();

  const conversation = useMemo<Conversation | undefined>(
    () => conversations.find(cv => cv.id === conversationId),
    [conversations, conversationId]
  );

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<RenderRow>>(null);
  const typingTimer = useRef<NodeJS.Timeout | null>(null);

  // ── ActionSheet state (OpenChat-uxj, OpenChat-46p, OpenChat-wgl) ──────────
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [actionSheetMessage, setActionSheetMessage] = useState<Message | null>(null);
  const [actionSheetIsOwn, setActionSheetIsOwn] = useState(false);
  const [actionSheetSenderName, setActionSheetSenderName] = useState('');

  // ── Reply state ────────────────────────────────────────────────────────────
  const [replyTo, setReplyTo] = useState<ReplyToData | null>(null);

  // ── Toast state ────────────────────────────────────────────────────────────
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<NodeJS.Timeout | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastVisible(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 3200);
  }, []);

  // Map from messageId → row index for scroll-to-quoted.
  const messageIndexRef = useRef<Map<string, number>>(new Map());

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

  // Activate this conversation in context on mount; clear on unmount.
  // Also tell the notification service so it can suppress foreground banners
  // for messages arriving in the conversation the user is already viewing.
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

  // Does this conversation include any bot participant? (OpenChat-ds3)
  const containsBot = useMemo(
    () => conversation?.participants?.some(p => p.user.isBot) ?? false,
    [conversation]
  );

  // Mute menu logic (OpenChat-aes)
  const isMuted = !!mutedConvs[conversationId];

  const showMuteMenu = () => {
    const muteLabel = isMuted ? 'Unmute' : 'Mute';
    const options = isMuted
      ? ['Unmute', 'Cancel']
      : ['For 1 hour', 'For 8 hours', 'Until tomorrow', 'Always', 'Cancel'];
    const cancelIndex = options.length - 1;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, title: isMuted ? 'Unmute conversation' : 'Mute notifications' },
        async (idx) => {
          if (idx === cancelIndex) return;
          if (isMuted) {
            await muteConv(conversationId, null);
          } else {
            const now = new Date();
            let until: Date | 'always';
            if (idx === 0) {
              until = new Date(now.getTime() + 60 * 60 * 1000);
            } else if (idx === 1) {
              until = new Date(now.getTime() + 8 * 60 * 60 * 1000);
            } else if (idx === 2) {
              const tomorrow = new Date(now);
              tomorrow.setDate(tomorrow.getDate() + 1);
              tomorrow.setHours(9, 0, 0, 0);
              until = tomorrow;
            } else {
              until = 'always';
            }
            await muteConv(conversationId, until);
          }
        }
      );
    } else {
      // Android: use Alert with a simple "mute always / unmute" fallback
      Alert.alert(
        isMuted ? 'Unmute conversation?' : 'Mute conversation?',
        isMuted ? undefined : 'You will stop receiving notification banners for this chat.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: isMuted ? 'Unmute' : 'Mute always',
            onPress: () => void muteConv(conversationId, isMuted ? null : 'always'),
          },
        ]
      );
    }
  };

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
              {isGroup && containsBot && <BotBadge isBot compact />}
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
      headerRight: () => (
        <TouchableOpacity
          onPress={showMuteMenu}
          accessibilityLabel={isMuted ? 'Unmute conversation' : 'Mute conversation'}
          style={{ paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          {isMuted && (
            <Text style={{ fontSize: 14, color: c.textMuted }}>🔕</Text>
          )}
          <Text style={{ color: c.textSecondary, fontSize: 20, lineHeight: 22 }}>⋯</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, isGroup, headerTitle, conversationId, conversation?.participants?.length, other, presence, c.textPrimary, c.textSecondary, c.textMuted, containsBot, isMuted, showMuteMenu]);

  const rows = useMemo(() => {
    const built = buildRows(messages, currentUser?.userId);
    // Rebuild messageId → row index map for scroll-to-quoted.
    const map = new Map<string, number>();
    built.forEach((r, i) => {
      if (r.type === 'message' && r.message) map.set(r.message.id, i);
    });
    messageIndexRef.current = map;
    return built;
  }, [messages, currentUser?.userId]);

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

  // Haptic feedback on incoming messages (OpenChat-o8m).
  // Fires when a new message arrives in this (active) conversation from
  // someone other than the current user.
  const prevLenForHapticRef = useRef(0);
  useEffect(() => {
    const len = messages.length;
    if (len > prevLenForHapticRef.current) {
      const latest = messages[len - 1];
      if (latest && latest.senderId !== currentUser?.userId) {
        hapticReceive();
      }
    }
    prevLenForHapticRef.current = len;
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
    const currentReplyToId = replyTo?.messageId;
    setText('');
    setReplyTo(null);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    reportTyping(conversationId, false);
    try {
      await sendMessage(trimmed, currentReplyToId);
      hapticSend(); // light impact on successful send (iOS only)
    } catch (err) {
      // The context already tagged the optimistic message _failed=true.
      console.warn('[ChatScreen] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  // ── Long-press handler ─────────────────────────────────────────────────────
  const handleLongPress = useCallback((m: Message, isOwn: boolean, senderName: string) => {
    setActionSheetMessage(m);
    setActionSheetIsOwn(isOwn);
    setActionSheetSenderName(senderName);
    setActionSheetVisible(true);
  }, []);

  // ── ActionSheet callbacks ──────────────────────────────────────────────────
  const handleReply = useCallback((data: ReplyToData) => {
    setReplyTo(data);
  }, []);

  const handleBlock = useCallback(async (userId: string, displayName: string) => {
    try {
      await blockUser(userId);
      navigation.goBack();
    } catch (err) {
      console.warn('[ChatScreen] block failed:', err);
      Alert.alert('Error', `Could not block ${displayName}. Please try again.`);
    }
  }, [blockUser, navigation]);

  const handleReport = useCallback(async (messageId: string, reason: string, freeform?: string) => {
    try {
      await api.submitReport({ targetType: 'message', targetId: messageId, reason, freeform });
    } catch (err) {
      console.warn('[ChatScreen] report failed:', err);
    }
    showToast("Thanks — we've received your report");
  }, [showToast]);

  // ── Scroll to quoted message ───────────────────────────────────────────────
  const scrollToMessage = useCallback((messageId: string) => {
    const idx = messageIndexRef.current.get(messageId);
    if (idx == null) return;
    try {
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
    } catch {
      // scrollToIndex can throw if item isn't rendered — ignore.
    }
  }, []);

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

  const showAiDisclosure = containsBot && !aiDisclosureAcceptedAt;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
      keyboardVerticalOffset={kbOffset}
    >
      {showAiDisclosure && <AiDisclosureBanner />}

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
          contentContainerStyle={{ padding: 12, gap: 6 }}
          onScroll={handleScroll}
          // Throttle scroll events to ~60fps; high enough to catch the
          // user reaching bottom quickly, low enough not to thrash JS.
          scrollEventThrottle={16}
          onScrollToIndexFailed={() => { /* target not in window — ignore */ }}
          // Empty-state placeholder when the thread has no messages (OpenChat-0kl).
          ListEmptyComponent={
            !loadingMessages ? (
              <ChatEmptyState conversation={conversation} currentUser={currentUser} />
            ) : null
          }
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
                <TouchableOpacity
                  activeOpacity={0.85}
                  onLongPress={() => handleLongPress(m, isOwn, m.sender?.name || m.sender?.email || '')}
                  delayLongPress={350}
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
                  {/* Reply quote header — shown if this message is a reply (OpenChat-uxj) */}
                  {m.replyToId && (
                    <TouchableOpacity
                      onPress={() => m.replyToId && scrollToMessage(m.replyToId)}
                      activeOpacity={0.7}
                      style={[
                        styles.replyHeader,
                        {
                          borderLeftColor: isOwn ? 'rgba(255,255,255,0.6)' : c.primary,
                          backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : c.surfaceElevated,
                        },
                      ]}
                    >
                      <Text
                        style={[styles.replyHeaderAuthor, { color: isOwn ? 'rgba(255,255,255,0.85)' : colorForUserId(m.replyTo?.senderId, scheme) }]}
                        numberOfLines={1}
                      >
                        {m.replyTo?.sender?.name || m.replyTo?.sender?.email || 'Reply'}
                      </Text>
                      <Text
                        style={[styles.replyHeaderContent, { color: isOwn ? 'rgba(255,255,255,0.7)' : c.textSecondary }]}
                        numberOfLines={2}
                      >
                        {m.replyTo?.content || '…'}
                      </Text>
                    </TouchableOpacity>
                  )}
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
                </TouchableOpacity>
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
          <Text style={{ color: c.textSecondary, fontSize: 12 }}>{typingLabel}</Text>
        </View>
      )}

      {/* Reply preview bar — shown above composer when replying (OpenChat-uxj) */}
      {replyTo && (
        <View style={[styles.replyBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={[styles.replyBarAccent, { backgroundColor: colorForUserId(replyTo.senderId, scheme) }]} />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={[styles.replyBarAuthor, { color: colorForUserId(replyTo.senderId, scheme) }]} numberOfLines={1}>
              {replyTo.senderName}
            </Text>
            <Text style={[styles.replyBarContent, { color: c.textSecondary }]} numberOfLines={2}>
              {replyTo.content}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setReplyTo(null)}
            style={styles.replyBarClose}
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          >
            <Text style={{ color: c.textMuted, fontSize: 22, lineHeight: 26 }}>×</Text>
          </TouchableOpacity>
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

      {/* Message action sheet (OpenChat-uxj, OpenChat-46p, OpenChat-wgl) */}
      <MessageActionSheet
        visible={actionSheetVisible}
        message={actionSheetMessage}
        isOwn={actionSheetIsOwn}
        senderName={actionSheetSenderName}
        onDismiss={() => setActionSheetVisible(false)}
        onReply={handleReply}
        onBlock={handleBlock}
        onReport={handleReport}
      />

      {/* In-app toast for report confirmation */}
      <ToastMessage visible={toastVisible} message={toastMsg} />
    </KeyboardAvoidingView>
  );
}

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
  // Inline reply header inside a bubble (OpenChat-uxj)
  replyHeader: {
    borderLeftWidth: 3,
    paddingLeft: 8,
    paddingVertical: 4,
    marginBottom: 6,
    borderRadius: 4,
  },
  replyHeaderAuthor: { fontSize: 12, fontWeight: '600' as const, marginBottom: 1 },
  replyHeaderContent: { fontSize: 12 },
  // Reply preview bar above composer
  replyBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyBarAccent: {
    width: 3,
    alignSelf: 'stretch' as const,
    borderRadius: 2,
    minHeight: 30,
  },
  replyBarAuthor: { fontSize: 12, fontWeight: '600' as const, marginBottom: 1 },
  replyBarContent: { fontSize: 12 },
  replyBarClose: {
    paddingLeft: 12,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
});
