/**
 * Chat thread — read messages, send, see typing indicator. The conversation
 * is identified by route param; we read the conversation metadata from the
 * context list so we stay in sync with rename / participant changes.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
import { Attachment, Conversation, ExportRangeKey, Message, api } from '../api/client';
import { MessageActionSheet, ReplyToData } from '../components/MessageActionSheet';
import { ReactionsBar } from '../components/ReactionsBar';
import { ToastMessage } from '../components/ToastMessage';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { AiDisclosureBanner } from '../components/AiDisclosureBanner';
import { BotBadge } from '../components/BotBadge';
import { AppIcon } from '../components/AppIcon';
import { NewMessagesPill } from '../components/NewMessagesPill';
import { ChatEmptyState } from '../components/ChatEmptyState';
import type { NavProp, RouteProps } from '../navigation/types';
import { setActiveConversationForNotifications } from '../services/notifications';
import { hapticSend, hapticReceive } from '../services/haptics';
import { colorForUserId } from '../utils/colorForUserId';
import { pickImage, uploadImage, PickedAsset, uploadAudio } from '../services/attachments';
import { startRecording, stopRecording, cancelRecording } from '../services/audioRecorder';
import type { Recording } from '../services/audioRecorder';
import { VoiceMessageBubble } from '../components/VoiceMessageBubble';
import { MentionAutocomplete, MentionCandidate } from '../components/MentionAutocomplete';
import { TransformButton } from '../components/TransformButton';
import { NVCComposerModal } from '../components/NVCComposerModal';
import { LinkPreviewCard } from '../components/LinkPreviewCard';
import type { Participant } from '../api/client';
import { ExportSheet } from '../components/ExportSheet';
import { saveJsonDownload } from '../services/exportDownload';
import { logError, logWarn } from '../services/clientLogger';
import { serif } from '../theme/typography';

const TYPING_DEBOUNCE_MS = 2000; // auto-clear typing after this much silence

// ── Voice message constants (OpenChat-xxc) ─────────────────────────────────
const MAX_RECORDING_MS = 5 * 60 * 1000; // 5 minutes cap
const CANCEL_DRAG_PX = 80; // horizontal drag distance to cancel recording
// Press shorter than this is treated as a TAP → hands-free (locked) recording
// (OpenChat-9de). A longer press is a HOLD → record-while-held, send on release.
const TAP_THRESHOLD_MS = 350;

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

/**
 * Renders message content with @Name tokens highlighted in the sender's color
 * when the name matches a conversation participant (OpenChat-0jy).
 *
 * Returns an array of React Native <Text> elements that can be nested inside
 * a parent <Text> node.
 */
function renderContentWithMentions(
  content: string,
  participants: Participant[],
  baseColor: string,
  scheme: 'light' | 'dark'
): React.ReactElement {
  // Build a name → userId map for quick lookup.
  const nameMap = new Map<string, string>();
  for (const p of participants) {
    const displayName = p.user.name || p.user.email.split('@')[0] || p.user.email;
    nameMap.set(displayName.toLowerCase(), p.user.id);
    // Also map by email local part as fallback.
    const localPart = p.user.email.split('@')[0].toLowerCase();
    if (!nameMap.has(localPart)) nameMap.set(localPart, p.user.id);
  }

  const parts: React.ReactElement[] = [];
  const regex = /@([\w-]+(?:\s+[\w-]+)?)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(content)) !== null) {
    const token = match[1];
    const userId = nameMap.get(token.toLowerCase());
    if (!userId) continue; // not a known participant — treat as plain text

    // Text before this token
    if (match.index > last) {
      parts.push(
        <Text key={`plain-${idx++}`} style={{ color: baseColor }}>
          {content.slice(last, match.index)}
        </Text>
      );
    }

    const mentionColor = colorForUserId(userId, scheme);
    parts.push(
      <Text key={`mention-${idx++}`} style={{ color: mentionColor, fontWeight: '700' }}>
        @{token}
      </Text>
    );
    last = match.index + match[0].length;
  }

  // Remaining plain text
  if (last < content.length) {
    parts.push(
      <Text key={`plain-${idx++}`} style={{ color: baseColor }}>
        {content.slice(last)}
      </Text>
    );
  }

  if (parts.length === 0) {
    return <Text style={{ color: baseColor }}>{content}</Text>;
  }

  return <Text>{parts}</Text>;
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

/**
 * ChatScreen props (OpenChat-601.2):
 *
 * The component is mounted in two contexts now:
 *   1. /m/ + native — as a stack screen via ChatsNavigator. Reads
 *      conversationId from the route, configures the native-stack header
 *      via navigation.setOptions.
 *   2. /d/ — embedded inside MasterDetailLayout's right pane. The parent
 *      passes conversationId via props and asks us to skip header setup
 *      via `embedded` (the master-detail provides its own chrome).
 *
 * Both contexts share the same body: the entire message thread, composer,
 * action sheet, reactions, transforms, voice / image / link previews,
 * mention autocomplete, etc. — giving /d/ full feature parity with /m/.
 */
interface ChatScreenProps {
  /** Override conversationId. Required when used outside the Chat route. */
  conversationId?: string;
  /** When true, skip navigation.setOptions (parent owns the chrome). */
  embedded?: boolean;
}

export function ChatScreen({
  conversationId: conversationIdProp,
  embedded = false,
}: ChatScreenProps = {}) {
  const navigation = useNavigation<NavProp<'Chat'>>();
  // Read route params defensively: when embedded inside MasterDetailLayout
  // we're under a different route name ('Conversations'), so the Chat
  // params shape isn't available. Fall back to the prop.
  const routeRaw = useRoute();
  const conversationId =
    conversationIdProp
    ?? (routeRaw.name === 'Chat'
        ? ((routeRaw.params as { conversationId?: string } | undefined)?.conversationId ?? '')
        : '');
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
    currentUser, conversations, messages, loadingMessages, isConnected,
    loadOlderMessages, hasMoreMessages, loadingOlderMessages,
    setActiveConversation, sendMessage, editMessage, deleteMessage, toggleReaction,
    presence, typingByConv, reportTyping,
    aiDisclosureAcceptedAt, mutedConvs, muteConv, blockUser,
    readByOthers, onlineUsers, markConversationRead,
  } = useChat();

  const conversation = useMemo<Conversation | undefined>(
    () => conversations.find(cv => cv.id === conversationId),
    [conversations, conversationId]
  );

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  // NVC composer modal (OpenChat-3kr.2) — Observation / Feeling / Need /
  // Request scaffold. Optional mode for difficult conversations.
  const [nvcVisible, setNvcVisible] = useState(false);

  // ── @-mention autocomplete state (OpenChat-0jy) ────────────────────────────
  // mentionQuery: the text typed after the triggering '@' at the cursor position.
  // null when no active mention trigger is in progress.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // Tracks the char-offset of the '@' that triggered the current mention pick.
  const mentionAtOffset = useRef<number>(-1);
  const textInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<RenderRow>>(null);
  const typingTimer = useRef<NodeJS.Timeout | null>(null);

  // ── ActionSheet state (OpenChat-uxj, OpenChat-46p, OpenChat-wgl, OpenChat-q9h, OpenChat-7bd)
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [actionSheetMessage, setActionSheetMessage] = useState<Message | null>(null);
  const [actionSheetIsOwn, setActionSheetIsOwn] = useState(false);
  const [actionSheetSenderName, setActionSheetSenderName] = useState('');

  // ── Reply state ────────────────────────────────────────────────────────────
  const [replyTo, setReplyTo] = useState<ReplyToData | null>(null);

  // ── Edit mode state (OpenChat-q9h) ─────────────────────────────────────────
  // When set, the composer is in "edit" mode: Send = PATCH, Escape = cancel.
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);

  // ── Attachment state (OpenChat-6bg) ────────────────────────────────────────
  // pendingAsset: picked but not yet uploaded (shown as preview above composer)
  const [pendingAsset, setPendingAsset] = useState<PickedAsset | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  // fullscreen viewer
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  // ── Voice recording state (OpenChat-xxc) ───────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  // Hands-free / locked mode (OpenChat-9de): set when the mic was TAPPED rather
  // than held. Recording continues after the finger lifts; the user ends it with
  // the Stop button (send) or Cancel button (discard) in the recording bar.
  const [recordingLocked, setRecordingLocked] = useState(false);
  const recordingLockedRef = useRef(false);
  const [recordingCancelled, setRecordingCancelled] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingMaxTimerRef = useRef<NodeJS.Timeout | null>(null);
  const micPressStartXRef = useRef<number>(0);
  // Wall-clock time the mic press began — used to tell a TAP from a HOLD.
  const micPressStartTimeRef = useRef<number>(0);
  // Release that happened while the recorder was still starting up
  // (Audio.Recording.createAsync takes 100-500ms, so a quick TAP lifts before
  // recordingRef is set). handleMicPressIn applies it once the recording
  // exists — without this, tap-for-hands-free never engaged (OpenChat-7nu).
  const pendingReleaseRef = useRef<{ atMs: number; cancelled: boolean } | null>(null);
  // Stable ref to the current finishRecording closure, so out-of-render callers
  // (the 5-minute hard-cap timer) avoid a stale closure.
  const finishRecordingRef = useRef<(wasCancelled: boolean) => Promise<void>>(async () => {});

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

  // ── Transform banner state (OpenChat-8a0) ──────────────────────────────────
  // originalText: the text before the transform (for Undo).
  // transformLabel: display label shown in the banner, e.g. "NVC Rewrite".
  const [originalText, setOriginalText] = useState<string | null>(null);
  const [transformLabel, setTransformLabel] = useState<string>('');

  const handleTransformed = useCallback((rewrittenText: string, label: string) => {
    setOriginalText(text);
    setTransformLabel(label);
    setText(rewrittenText);
  }, [text]);

  const handleTransformUndo = useCallback(() => {
    if (originalText !== null) setText(originalText);
    setOriginalText(null);
    setTransformLabel('');
  }, [originalText]);

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
  // Set to true by loadOlderMessages so the messages effect doesn't fire
  // scroll-to-end or unread bump when older messages are prepended (OpenChat-vjc).
  const prependingOlderRef = useRef(false);

  // Activate this conversation in context on mount; clear on unmount.
  // Also tell the notification service so it can suppress foreground banners
  // for messages arriving in the conversation the user is already viewing.
  useEffect(() => {
    setActiveConversation(conversationId);
    setActiveConversationForNotifications(conversationId);
    // Mark as read when the user opens the conversation (OpenChat-0nj).
    markConversationRead(conversationId);
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
  }, [conversationId, setActiveConversation, markConversationRead]);

  const isGroup = conversation?.type === 'group';
  // Self-DM detection: direct conversation with no participant other than me.
  // Could be a single-edge self conversation or a degenerate 1-participant DM.
  const isSelfDM = !isGroup
    && !!conversation?.participants
    && conversation.participants.every(p => p.user.id === currentUser?.userId);
  // The 'other' user for a non-self DM. Self-DM = me, so I appear as the
  // "other" so the header shows my own name + avatar instead of "Unknown".
  const other = !isGroup
    ? (isSelfDM
        ? conversation?.participants?.[0]?.user
        : conversation?.participants?.find(p => p.user.id !== currentUser?.userId)?.user)
    : null;

  // Participants eligible for @-mention — all except self (OpenChat-0jy).
  const mentionableParticipants = useMemo(() => {
    if (!isGroup) return [];
    return (conversation?.participants || []).filter(
      p => p.user.id !== currentUser?.userId
    );
  }, [isGroup, conversation?.participants, currentUser?.userId]);
  const headerTitle = useMemo(() => {
    if (!conversation) return '';
    if (conversation.title) return conversation.title;
    // Self-DM: WhatsApp-style "You" label. Matches the "Notes to self" pattern.
    if (isSelfDM) return 'You';
    if (!isGroup) return other?.name || other?.email || 'Chat';
    const others = (conversation.participants || [])
      .filter(p => p.user.id !== currentUser?.userId)
      .map(p => p.user.name || p.user.email?.split('@')[0] || '?');
    if (others.length === 0) return 'Group';
    if (others.length <= 2) return others.join(', ');
    return `${others[0]} +${others.length - 1}`;
  }, [conversation, isGroup, isSelfDM, other, currentUser?.userId]);

  // Does this conversation include any bot participant? (OpenChat-ds3)
  const containsBot = useMemo(
    () => conversation?.participants?.some(p => p.user.isBot) ?? false,
    [conversation]
  );

  // Mute menu logic (OpenChat-aes)
  const isMuted = !!mutedConvs[conversationId];
  const [exportSheetVisible, setExportSheetVisible] = useState(false);
  const [exportBusyRange, setExportBusyRange] = useState<ExportRangeKey | null>(null);

  const handleConversationExport = useCallback(async (range: ExportRangeKey) => {
    if (!isConnected || exportBusyRange) return;
    setExportBusyRange(range);
    try {
      const download = await api.exportConversation(conversationId, range);
      const filename = await saveJsonDownload(download.filename, download.text);
      setExportSheetVisible(false);
      showToast(`Export ready: ${filename}`);
    } catch (err) {
      console.warn('[ChatScreen] export failed:', err);
      Alert.alert(
        'Export failed',
        !isConnected
          ? 'OpenChat is offline. Reconnect, then try the export again.'
          : err instanceof Error
            ? err.message
            : 'Could not export this conversation.'
      );
    } finally {
      setExportBusyRange(null);
    }
  }, [conversationId, exportBusyRange, isConnected, showToast]);

  // "…" menu: mute controls + export (export moved out of the header per
  // 2026-09-02 feedback — the download icon crowded the contact name).
  const showMuteMenu = () => {
    const muteOptions = isMuted
      ? ['Unmute']
      : ['Mute for 1 hour', 'Mute for 8 hours', 'Mute until tomorrow', 'Mute always'];
    const options = [...muteOptions, 'Export conversation…', 'Cancel'];
    const exportIndex = muteOptions.length;
    const cancelIndex = options.length - 1;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex },
        async (idx) => {
          if (idx === cancelIndex) return;
          if (idx === exportIndex) {
            setExportSheetVisible(true);
            return;
          }
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
          { text: 'Export conversation…', onPress: () => setExportSheetVisible(true) },
          {
            text: isMuted ? 'Unmute' : 'Mute always',
            onPress: () => void muteConv(conversationId, isMuted ? null : 'always'),
          },
        ]
      );
    }
  };

  useLayoutEffect(() => {
    // Embedded in MasterDetailLayout — the parent owns the chrome.
    if (embedded) return;
    navigation.setOptions({
      headerTitle: () => (
        <TouchableOpacity
          onPress={() => {
            if (isGroup) {
              navigation.navigate('GroupSettings', { conversationId });
            } else if (isSelfDM) {
              // Self-DM header → open your own profile edit screen.
              navigation.navigate('ProfileEdit');
            } else if (other?.id) {
              navigation.navigate('ContactProfile', { userId: other.id });
            }
          }}
          disabled={!isGroup && !isSelfDM && !other?.id}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}
        >
          <Avatar
            name={!isGroup ? (other?.name || other?.email) : headerTitle}
            email={other?.email}
            isBot={!isGroup ? other?.isBot : false}
            avatarUrl={!isGroup ? other?.avatarUrl : undefined}
            size={28}
          />
          <View style={{ flexShrink: 1, flexGrow: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: c.textPrimary, fontWeight: '600', fontSize: 19, fontFamily: serif, flexShrink: 1 }} numberOfLines={1}>
                {headerTitle}
              </Text>
              {!isGroup && <BotBadge isBot={other?.isBot} compact />}
              {isGroup && containsBot && <BotBadge isBot compact />}
              {(isGroup || isSelfDM || other?.id) && (
                <View style={{ marginLeft: 5 }}><AppIcon name="info" color={c.textMuted} size={13} strokeWidth={1.8} /></View>
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
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() =>
              navigation.navigate('ConversationThoughts', {
                conversationId,
                title: headerTitle,
              })
            }
            accessibilityLabel="Thoughts for this chat"
            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <AppIcon name="thought" color={c.primary} size={20} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={showMuteMenu}
            accessibilityLabel={isMuted ? 'Unmute conversation' : 'Mute conversation'}
            style={{ minWidth: 44, minHeight: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }}
          >
            {isMuted && (
              <AppIcon name="mute" color={c.textMuted} size={15} strokeWidth={1.8} />
            )}
            <AppIcon name="more" color={c.textSecondary} size={20} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [embedded, navigation, isGroup, isSelfDM, headerTitle, conversationId, conversation?.participants?.length, other, presence, c.primary, c.textPrimary, c.textSecondary, c.textMuted, containsBot, isMuted, showMuteMenu]);

  // Ink & Paper: own bubbles are ink-on-paper (light) / paper-on-ink (dark),
  // so translucent overlays inside them derive from the bubble text color
  // instead of the old white-on-blue assumption.
  const ownTint = useCallback((opacity: number) => {
    const hex = c.bubbleOwnText.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${opacity})`;
  }, [c.bubbleOwnText]);

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

    // Older messages were prepended — skip scroll and unread bump (OpenChat-vjc).
    // maintainVisibleContentPosition handles keeping the scroll position stable.
    if (prependingOlderRef.current) {
      prependingOlderRef.current = false;
      return;
    }

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
  // someone other than the current user. Also marks the conversation as
  // read so the other party's tick can advance to "read" (OpenChat-0nj).
  const prevLenForHapticRef = useRef(0);
  useEffect(() => {
    const len = messages.length;
    if (len > prevLenForHapticRef.current) {
      const latest = messages[len - 1];
      if (latest && latest.senderId !== currentUser?.userId) {
        hapticReceive();
      }
      // Mark read whenever new messages arrive while we're in the thread.
      markConversationRead(conversationId);
    }
    prevLenForHapticRef.current = len;
  }, [messages, currentUser?.userId, conversationId, markConversationRead]);

  // When loadingOlderMessages transitions false→false (completed), flag the
  // next messages update as a prepend so the scroll/unread effect ignores it (OpenChat-vjc).
  const wasLoadingOlderRef = useRef(false);
  useEffect(() => {
    if (wasLoadingOlderRef.current && !loadingOlderMessages) {
      // Older messages just finished loading — next messages change is a prepend.
      prependingOlderRef.current = true;
    }
    wasLoadingOlderRef.current = loadingOlderMessages;
  }, [loadingOlderMessages]);

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

    // Load older messages when user scrolls near the top (OpenChat-vjc).
    if (contentOffset.y < 200 && hasMoreMessages && !loadingOlderMessages) {
      void loadOlderMessages(conversationId);
    }
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
    // Dismiss transform banner on any manual edit — the user has moved on.
    if (originalText !== null) {
      setOriginalText(null);
      setTransformLabel('');
    }
    // Typing throttle: emit typing:start on first keystroke, auto-stop after silence.
    if (next.length > 0) {
      reportTyping(conversationId, true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => reportTyping(conversationId, false), TYPING_DEBOUNCE_MS);
    } else {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      reportTyping(conversationId, false);
    }

    // @-mention trigger detection (OpenChat-0jy) — groups only.
    // Look for an unfinished @token at the end of the string (or at the
    // current known cursor position). We use a simple regex: the substring
    // from the last '@' that isn't preceded by a word char and isn't
    // followed by a space (i.e. the token is still being typed).
    if (isGroup) {
      const match = next.match(/@([\w-]*)$/);
      if (match) {
        // The '@' is at index (next.length - 1 - match[1].length - 1 + 1)
        mentionAtOffset.current = next.length - 1 - match[1].length;
        setMentionQuery(match[1]);
      } else {
        mentionAtOffset.current = -1;
        setMentionQuery(null);
      }
    }
  };

  const handleMentionSelect = useCallback((candidate: MentionCandidate) => {
    // Replace "@prefix" with "@DisplayName " in the text.
    const atOffset = mentionAtOffset.current;
    if (atOffset < 0) return;
    const before = text.slice(0, atOffset); // text before the '@'
    const insertion = `@${candidate.displayName} `;
    const newText = before + insertion;
    setText(newText);
    setMentionQuery(null);
    mentionAtOffset.current = -1;
    // Focus the input so the user can keep typing after selection.
    textInputRef.current?.focus();
  }, [text]);

  // ── Attachment pick handler (OpenChat-6bg) ────────────────────────────────
  const handlePickAttachment = useCallback(async () => {
    if (sending || uploadingAttachment) return;
    const asset = await pickImage();
    if (asset) setPendingAsset(asset);
  }, [sending, uploadingAttachment]);

  // ── Voice recording handlers (OpenChat-xxc) ──────────────────────────────

  /** Called when the mic button is pressed in. Starts recording. */
  const handleMicPressIn = useCallback(async (pageX: number) => {
    // Locked (hands-free) recording: the composer button shows a stop square,
    // so tapping it must stop-and-send (2026-09-02 feedback: "the one below
    // doesn't seem to do anything").
    if (isRecording && recordingLockedRef.current) {
      void finishRecordingRef.current(false);
      return;
    }
    if (sending || uploadingAttachment || isRecording || Platform.OS === 'web') return;
    micPressStartXRef.current = pageX;
    micPressStartTimeRef.current = Date.now();
    pendingReleaseRef.current = null;
    setRecordingCancelled(false);
    setRecordingElapsedMs(0);

    try {
      const rec = await startRecording();
      recordingRef.current = rec;
      recordingStartTimeRef.current = Date.now();
      setIsRecording(true);

      // Elapsed-time ticker (updates every 100 ms).
      recordingTimerRef.current = setInterval(() => {
        setRecordingElapsedMs(Date.now() - recordingStartTimeRef.current);
      }, 100);

      // Hard cap at 5 minutes. Use ref to avoid stale closure.
      recordingMaxTimerRef.current = setTimeout(() => {
        void finishRecordingRef.current(false);
      }, MAX_RECORDING_MS);

      // Apply a release that landed while the recorder was still starting
      // (OpenChat-7nu): short press → hands-free lock; long press → send;
      // drag/cancel → discard.
      // (assertion: TS keeps the `= null` narrowing from before the await,
      // but handleMicPressOut may have written here while we awaited)
      const release = pendingReleaseRef.current as { atMs: number; cancelled: boolean } | null;
      if (release) {
        pendingReleaseRef.current = null;
        const pressMs = release.atMs - micPressStartTimeRef.current;
        if (release.cancelled) {
          void finishRecordingRef.current(true);
        } else if (pressMs < TAP_THRESHOLD_MS) {
          recordingLockedRef.current = true;
          setRecordingLocked(true);
        } else {
          void finishRecordingRef.current(false);
        }
      }
    } catch (err) {
      // Most common: microphone permission denied. Surface a clear message
      // rather than silently failing (OpenChat-9de).
      logError('[voice] startRecording failed', err);
      setIsRecording(false);
      const denied = err instanceof Error && /permission/i.test(err.message);
      Alert.alert(
        denied ? 'Microphone access needed' : 'Recording failed',
        denied
          ? 'Enable microphone access in Settings to send voice messages.'
          : 'Could not start recording. Please try again.'
      );
    }
  }, [sending, uploadingAttachment, isRecording]);

  /**
   * Called when the finger lifts off the mic button. Distinguishes a TAP (short
   * press → hands-free locked recording) from a HOLD (record-while-held → send
   * on release). A drag-cancel passes wasCancelled=true. (OpenChat-9de)
   */
  const handleMicPressOut = useCallback(async (wasCancelled: boolean) => {
    if (!recordingRef.current) {
      // The recorder may still be starting (createAsync in flight). Remember
      // this release so handleMicPressIn can apply it when the recording
      // materializes (OpenChat-7nu).
      if (micPressStartTimeRef.current > 0) {
        pendingReleaseRef.current = { atMs: Date.now(), cancelled: wasCancelled };
      }
      return;
    }

    // In locked (hands-free) mode the finger lift is a no-op — recording keeps
    // going until the user taps Stop or Cancel.
    if (recordingLockedRef.current) return;

    const pressMs = Date.now() - micPressStartTimeRef.current;

    // Short press that was NOT a drag-cancel → enter hands-free locked mode.
    if (!wasCancelled && pressMs < TAP_THRESHOLD_MS) {
      recordingLockedRef.current = true;
      setRecordingLocked(true);
      return;
    }

    // Otherwise it's a HOLD release (or a cancel) → finish the recording.
    await finishRecording(wasCancelled);
  }, [isRecording, sending, sendMessage, replyTo, uploadAudio]);

  /**
   * Ends the current recording: sends it (wasCancelled=false) or discards it
   * (wasCancelled=true). Shared by the hold-release path, the locked-mode
   * Stop/Cancel buttons, and the 5-minute hard cap. (OpenChat-xxc / 9de)
   */
  const finishRecording = useCallback(async (wasCancelled: boolean) => {
    if (!recordingRef.current) return;

    // Clear timers.
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    if (recordingMaxTimerRef.current) { clearTimeout(recordingMaxTimerRef.current); recordingMaxTimerRef.current = null; }

    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    recordingLockedRef.current = false;
    setRecordingLocked(false);

    if (!rec) return;

    if (wasCancelled) {
      setRecordingCancelled(true);
      setTimeout(() => setRecordingCancelled(false), 1200); // show cancel feedback briefly
      await cancelRecording(rec);
      return;
    }

    // Stop and send.
    let uri: string;
    let durationMs: number;
    try {
      const result = await stopRecording(rec);
      uri = result.uri;
      durationMs = result.durationMs;
    } catch (err) {
      logError('[voice] stopRecording failed', err);
      Alert.alert('Recording failed', 'Could not finish the recording. Please try again.');
      return;
    }

    // expo-av can report durationMillis=0 even for a real recording (the
    // native stop status omits it on some iOS versions) — fall back to
    // wall-clock elapsed so we don't silently discard it (OpenChat-7nu).
    const wallMs = Date.now() - recordingStartTimeRef.current;
    if (durationMs <= 0) durationMs = wallMs;

    // Ignore extremely short recordings (< 500 ms — likely accidental tap).
    if (durationMs < 500) {
      logWarn('[voice] discarded ultra-short recording', { durationMs, wallMs });
      return;
    }

    setSending(true);
    try {
      const att = await uploadAudio(uri, durationMs);
      await sendMessage('', replyTo?.messageId, [att]);
      setReplyTo(null);
      hapticSend();
    } catch (err) {
      logError('[voice] upload/send failed', err, { durationMs });
      Alert.alert('Voice message failed', 'Could not send the voice message. Please try again.');
    } finally {
      setSending(false);
      setRecordingElapsedMs(0);
    }
  }, [sendMessage, replyTo, uploadAudio]);

  // Cancel any live recording when the chat unmounts — otherwise expo-av's
  // singleton recorder stays prepared and the NEXT mic press throws
  // ("failed the first time, worked the second"). Also clears the tickers.
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (recordingMaxTimerRef.current) clearTimeout(recordingMaxTimerRef.current);
      const rec = recordingRef.current;
      if (rec) {
        recordingRef.current = null;
        void cancelRecording(rec);
      }
    };
  }, []);

  // Keep the ref up to date so the max-duration timer (and any other
  // out-of-render caller) always invokes the current finishRecording closure.
  useEffect(() => {
    finishRecordingRef.current = finishRecording;
  }, [finishRecording]);

  const handleSend = async () => {
    const trimmed = text.trim();
    const hasAttachment = !!pendingAsset;
    if (!trimmed && !hasAttachment || sending) return;
    if (!isConnected) {
      Alert.alert('Offline', 'OpenChat is offline. Your message was not sent. Reconnect, then try again.');
      return;
    }
    setSending(true);

    // Edit mode: PATCH existing message (OpenChat-q9h). Attachments not editable.
    if (editingMessage) {
      const msgId = editingMessage.id;
      setText('');
      setEditingMessage(null);
      try {
        await editMessage(msgId, trimmed);
      } catch (err) {
        console.warn('[ChatScreen] edit failed:', err);
        Alert.alert('Error', 'Could not save your edit. Please try again.');
      } finally {
        setSending(false);
      }
      return;
    }

    const currentReplyToId = replyTo?.messageId;
    const assetToUpload = pendingAsset;
    setText('');
    setReplyTo(null);
    setPendingAsset(null);
    setMentionQuery(null);
    mentionAtOffset.current = -1;
    // Dismiss transform banner on send (intentional commit of the transform).
    setOriginalText(null);
    setTransformLabel('');
    if (typingTimer.current) clearTimeout(typingTimer.current);
    reportTyping(conversationId, false);

    try {
      let attachments: Attachment[] | undefined;
      if (assetToUpload) {
        setUploadingAttachment(true);
        try {
          const att = await uploadImage(assetToUpload);
          attachments = [att];
        } finally {
          setUploadingAttachment(false);
        }
      }
      await sendMessage(trimmed, currentReplyToId, attachments);
      hapticSend();
    } catch (err) {
      console.warn('[ChatScreen] send failed:', err);
      Alert.alert('Upload failed', 'Could not send the image. Please try again.');
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
  // Setting the reply target also focuses the composer so the keyboard rises
  // automatically — saves a redundant tap after picking "Reply" from the
  // long-press menu or swiping a message (OpenChat-imt).
  const handleReply = useCallback((data: ReplyToData) => {
    setReplyTo(data);
    // Defer focus until the next tick so the reply pill has a chance to mount
    // (otherwise the layout shift can swallow the focus event on Android).
    setTimeout(() => textInputRef.current?.focus(), 80);
  }, []);

  // Edit: load message content into composer in edit mode (OpenChat-q9h).
  const handleEdit = useCallback((message: Message) => {
    // Editing while a voice recording is live crashed / wedged the recorder
    // (2026-09-02 iPad report) — discard the recording before switching the
    // composer into edit mode.
    if (recordingRef.current) {
      void finishRecordingRef.current(true);
    }
    setEditingMessage(message);
    setReplyTo(null);
    setText(message.content);
  }, []);

  // Delete: soft-delete via context (OpenChat-q9h).
  const handleDelete = useCallback(async (messageId: string) => {
    try {
      await deleteMessage(messageId);
    } catch (err) {
      console.warn('[ChatScreen] delete failed:', err);
      Alert.alert('Error', 'Could not delete the message. Please try again.');
    }
  }, [deleteMessage]);

  // React: toggle emoji reaction (OpenChat-7bd).
  const handleReact = useCallback(async (messageId: string, emoji: string) => {
    try {
      await toggleReaction(messageId, emoji);
    } catch (err) {
      console.warn('[ChatScreen] reaction failed:', err);
    }
  }, [toggleReaction]);


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

  // Forward: navigate to conversation picker modal (OpenChat-hhc).
  const handleForward = useCallback((messageId: string) => {
    navigation.navigate('ForwardPicker', { messageId });
  }, [navigation]);

  // ── Forward to private Assistant DM (openchat-ug6) ─────────────────────────
  // Shared helper: posts to /api/assistant/forward and, on success, navigates
  // the user into their Assistant conversation. PRIVATE — nothing is posted
  // into the shared/source conversation.
  const forwardToAssistant = useCallback(
    async (message: Message, question?: string) => {
      try {
        const { conversationId: assistantConvId } = await api.forwardToAssistant({
          sourceConversationId: conversationId,
          sourceMessageId: message.id,
          ...(question ? { question } : {}),
        });
        navigation.navigate('Chat', { conversationId: assistantConvId });
      } catch (err) {
        console.warn('[ChatScreen] forward-to-assistant failed:', err);
        Alert.alert(
          'Could not reach your assistant',
          err instanceof Error ? err.message : 'Please try again.'
        );
      }
    },
    [conversationId, navigation]
  );

  const handleForwardToAssistant = useCallback(
    (message: Message) => { void forwardToAssistant(message); },
    [forwardToAssistant]
  );

  const handleAskAssistant = useCallback(
    (message: Message, question: string) => { void forwardToAssistant(message, question); },
    [forwardToAssistant]
  );

  // ── Save to Thoughts / Save & pin (unified capture affordance) ────────────
  // Saves the message text as a Thought with provenance back to this message;
  // pin=true additionally pins it to this conversation so every participant
  // sees it in the chat-scoped Thoughts view.
  const handleSaveToThoughts = useCallback(
    async (message: Message, pin: boolean) => {
      try {
        await api.createThought({
          text: message.content,
          sourceMessageId: message.id,
          ...(pin ? { pinToConversationId: conversationId } : {}),
        });
        showToast(pin ? 'Saved & pinned to this chat' : 'Saved to Thoughts');
      } catch (err) {
        logError('[thoughts] save-from-message failed', err, { pin });
        Alert.alert('Error', 'Could not save to Thoughts. Please try again.');
      }
    },
    [conversationId, showToast]
  );

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

  // Read-receipt tick state for own DM messages (OpenChat-0nj).
  // Returns 'sent' | 'delivered' | 'read'.
  // - 'read': the other participant's lastReadAt >= message.createdAt
  // - 'delivered': other user is currently online (has a socket)
  // - 'sent': fallback (message id confirmed by server)
  const getTickState = useCallback((msg: Message): 'sent' | 'delivered' | 'read' => {
    if (isGroup) return 'sent'; // v1: skip group read receipts
    if (!other) return 'sent';
    const convReadMap = readByOthers.get(conversationId);
    if (convReadMap) {
      const otherLastRead = convReadMap.get(other.id);
      if (otherLastRead && otherLastRead >= msg.createdAt) return 'read';
    }
    if (onlineUsers.get(other.id) === true) return 'delivered';
    return 'sent';
  }, [isGroup, other, readByOthers, onlineUsers, conversationId]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
      keyboardVerticalOffset={kbOffset}
    >
      {showAiDisclosure && <AiDisclosureBanner />}

      <ExportSheet
        visible={exportSheetVisible}
        title="Export conversation"
        subtitle="Download this chat as JSON. Choose a recent window or the full available history."
        disabledReason={!isConnected ? 'OpenChat is offline. Downloads need a live connection.' : null}
        busyRange={exportBusyRange}
        onClose={() => !exportBusyRange && setExportSheetVisible(false)}
        onExport={handleConversationExport}
      />

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
          contentContainerStyle={{ padding: 12, gap: 8 }}
          onScroll={handleScroll}
          // Throttle scroll events to ~60fps; high enough to catch the
          // user reaching bottom quickly, low enough not to thrash JS.
          scrollEventThrottle={16}
          onScrollToIndexFailed={() => { /* target not in window — ignore */ }}
          // Spinner at the top while loading older messages (OpenChat-vjc).
          ListHeaderComponent={
            loadingOlderMessages ? (
              <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={c.primary} />
              </View>
            ) : null
          }
          // Preserve scroll position when older messages are prepended (OpenChat-vjc).
          // maintainVisibleContentPosition keeps the first visible item in place on iOS.
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
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
                {/* Column wrapper so ReactionsBar renders below the bubble */}
                <View style={{ flexDirection: 'column', maxWidth: '78%', alignItems: isOwn ? 'flex-end' : 'flex-start' }}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onLongPress={() => handleLongPress(m, isOwn, m.sender?.name || m.sender?.email || '')}
                  delayLongPress={350}
                  style={[
                    styles.bubble,
                    {
                      backgroundColor: failed ? c.dangerMuted : (isOwn ? c.bubbleOwn : c.bubbleOther),
                      borderTopRightRadius: isOwn ? 4 : 16,
                      borderTopLeftRadius: isOwn ? 16 : 4,
                      borderColor: failed ? c.danger : (isOwn ? 'transparent' : c.border),
                      borderWidth: failed ? 1 : (isOwn ? 0 : StyleSheet.hairlineWidth),
                    },
                    // Reply-message accent stripe (OpenChat-imt): a 3px colored
                    // bar on the bubble's leading edge gives at-a-glance
                    // distinction that this message is a reply. Stripe sits on
                    // the LEFT for other-people's messages and the RIGHT for
                    // own messages, matching the bubble's tail orientation.
                    m.replyToId && !failed && (isOwn
                      ? { borderRightWidth: 3, borderRightColor: ownTint(0.55) }
                      : { borderLeftWidth: 3, borderLeftColor: c.primary }),
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
                          borderLeftColor: isOwn ? ownTint(0.6) : c.primary,
                          backgroundColor: isOwn ? ownTint(0.15) : c.surfaceElevated,
                        },
                      ]}
                    >
                      <Text
                        style={[styles.replyHeaderAuthor, { color: isOwn ? ownTint(0.85) : colorForUserId(m.replyTo?.senderId, scheme) }]}
                        numberOfLines={1}
                      >
                        {m.replyTo?.sender?.name || m.replyTo?.sender?.email || 'Reply'}
                      </Text>
                      <Text
                        style={[styles.replyHeaderContent, { color: isOwn ? ownTint(0.7) : c.textSecondary }]}
                        numberOfLines={2}
                      >
                        {m.replyTo?.content || '…'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {/* Forwarded-from label (OpenChat-hhc) */}
                  {!!m.viaSecretary && !m.deletedAt && (
                    <Text style={[styles.forwardedLabel, { color: isOwn ? ownTint(0.78) : c.textMuted }]}>
                      ◇ Secretary auto-reply
                    </Text>
                  )}
                  {!!m.forwardedFromMessageId && (
                    <Text style={[styles.forwardedLabel, { color: isOwn ? ownTint(0.7) : c.textMuted }]} numberOfLines={1}>
                      {'↪ Forwarded from '}{m.forwardedFromSenderName || 'Unknown'}
                    </Text>
                  )}
                  {item.showSender && m.sender && (
                    <Text style={[
                      styles.sender,
                      { color: isGroup ? senderColor : c.textSecondary },
                    ]}>
                      {m.sender.name || m.sender.email}
                    </Text>
                  )}
                  {/* Attachments: audio (OpenChat-xxc) or image (OpenChat-6bg) */}
                  {m.attachments?.map((att, i) => {
                    // ── Audio attachment ────────────────────────────────────
                    // Voice notes are first-class text (2026-09-02): the
                    // transcript IS the message; audio collapses to a compact
                    // play row under it. Until the transcript arrives (socket
                    // 'message:transcript'), show the full player + shimmer.
                    if (att.type === 'audio') {
                      const hasTranscript = !m.deletedAt && !!m.transcript;
                      return (
                        <View key={i}>
                          {hasTranscript && (
                            <Text style={{ fontSize: 16, color: isOwn ? c.bubbleOwnText : c.bubbleOtherText, marginBottom: 6 }}>
                              {m.transcript}
                            </Text>
                          )}
                          {!hasTranscript && !m.deletedAt && (
                            <Text style={{ fontSize: 13, fontStyle: 'italic', color: isOwn ? ownTint(0.6) : c.textMuted, marginBottom: 4 }}>
                              Transcribing…
                            </Text>
                          )}
                          <VoiceMessageBubble
                            messageId={m.id}
                            url={att.url}
                            durationMs={att.durationMs ?? 0}
                            isOwn={isOwn}
                            compact={hasTranscript}
                          />
                        </View>
                      );
                    }
                    // ── Image attachment ────────────────────────────────────
                    const aspectRatio = att.width && att.height ? att.width / att.height : 1;
                    return (
                      <TouchableOpacity
                        key={i}
                        onPress={() => setFullscreenImage(att.url)}
                        activeOpacity={0.85}
                        style={{ marginBottom: m.content ? 6 : 0 }}
                      >
                        <Image
                          source={{ uri: att.url }}
                          style={[
                            styles.attachmentImage,
                            { aspectRatio: Math.min(Math.max(aspectRatio, 0.5), 2) },
                          ]}
                          resizeMode="cover"
                        />
                      </TouchableOpacity>
                    );
                  })}
                  {/* Deleted: muted italic tombstone (OpenChat-q9h) */}
                  {m.deletedAt
                    ? <Text style={{ color: isOwn ? ownTint(0.55) : c.textMuted, fontSize: 15, fontStyle: 'italic' }}>Message deleted</Text>
                    : (!!m.content && (
                        isGroup
                          ? <Text style={{ fontSize: 16 }}>
                              {renderContentWithMentions(
                                m.content,
                                mentionableParticipants,
                                isOwn ? c.bubbleOwnText : c.bubbleOtherText,
                                scheme
                              )}
                            </Text>
                          : <Text style={{ color: isOwn ? c.bubbleOwnText : c.bubbleOtherText, fontSize: 16 }}>{m.content}</Text>
                      ))
                  }
                  <View style={styles.bubbleFooter}>
                    <Text style={{ color: isOwn ? ownTint(0.7) : c.textMuted, fontSize: 10 }}>
                      {failed ? 'Failed to send' : formatTime(m.createdAt)}
                    </Text>
                    {/* Edited tag (OpenChat-q9h) */}
                    {!!(m.editedAt && !m.deletedAt) && (
                      <Text style={{ color: isOwn ? ownTint(0.6) : c.textMuted, fontSize: 10, marginLeft: 4, fontStyle: 'italic' }}>edited</Text>
                    )}
                    {/* Tick marks for own DM messages (OpenChat-0nj). Only shown
                        after the local-optimistic id is replaced by a real server id. */}
                    {isOwn && !isGroup && !failed && !m.id.startsWith('local-') && (() => {
                      const tick = getTickState(m);
                      if (tick === 'read') {
                        return <Text style={{ color: scheme === 'dark' ? '#b3541e' : '#e08b5c', fontSize: 10, marginLeft: 3 }}>✓✓</Text>;
                      }
                      if (tick === 'delivered') {
                        return <Text style={{ color: ownTint(0.6), fontSize: 10, marginLeft: 3 }}>✓✓</Text>;
                      }
                      return <Text style={{ color: ownTint(0.5), fontSize: 10, marginLeft: 3 }}>✓</Text>;
                    })()}
                  </View>
                </TouchableOpacity>
                {/* Reactions bar below bubble (OpenChat-7bd) */}
                {!!(m.reactions && m.reactions.length > 0) && (
                  <ReactionsBar reactions={m.reactions!} isOwn={isOwn} onToggle={(emoji) => void handleReact(m.id, emoji)} />
                )}
                {/* Link preview cards below bubble (OpenChat-hq2) */}
                {!!(m.linkPreviews && m.linkPreviews.length > 0) && !m.deletedAt && m.linkPreviews.map((preview) => (
                  <LinkPreviewCard
                    key={preview.url}
                    preview={preview}
                    isOwn={isOwn}
                    scheme={scheme}
                  />
                ))}
                </View>{/* end column wrapper */}
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

      {/* Edit mode bar — shown above composer when editing (OpenChat-q9h) */}
      {editingMessage && (
        <View style={[styles.replyBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={[styles.replyBarAccent, { backgroundColor: c.primary }]} />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={[styles.replyBarAuthor, { color: c.primary }]}>Editing message</Text>
            <Text style={[styles.replyBarContent, { color: c.textSecondary }]} numberOfLines={1}>
              {editingMessage.content}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => { setEditingMessage(null); setText(''); }}
            style={styles.replyBarClose}
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          >
            <Text style={{ color: c.textMuted, fontSize: 22, lineHeight: 26 }}>×</Text>
          </TouchableOpacity>
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

      {/* Pending attachment preview bar (OpenChat-6bg) */}
      {pendingAsset && (
        <View style={[styles.attachmentPreviewBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Image
            source={{ uri: pendingAsset.uri }}
            style={styles.attachmentPreviewThumb}
            resizeMode="cover"
          />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={{ color: c.textPrimary, fontSize: 13 }} numberOfLines={1}>
              {pendingAsset.fileName}
            </Text>
            <Text style={{ color: c.textSecondary, fontSize: 11 }}>
              {pendingAsset.width && pendingAsset.height ? `${pendingAsset.width}×${pendingAsset.height}` : 'Image'}
              {pendingAsset.fileSize ? `  •  ${(pendingAsset.fileSize / 1024).toFixed(0)} KB` : ''}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setPendingAsset(null)}
            style={styles.replyBarClose}
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          >
            <Text style={{ color: c.textMuted, fontSize: 22, lineHeight: 26 }}>×</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* @-mention autocomplete dropdown — only shown in group chats (OpenChat-0jy) */}
      {isGroup && mentionQuery !== null && (
        <MentionAutocomplete
          query={mentionQuery}
          participants={mentionableParticipants}
          onSelect={handleMentionSelect}
          scheme={scheme}
        />
      )}

      {/* Transform banner — shown above composer after a transform (OpenChat-8a0) */}
      {originalText !== null && (
        <View style={[styles.replyBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={[styles.replyBarAccent, { backgroundColor: c.primary }]} />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={[styles.replyBarAuthor, { color: c.primary }]}>
              ✨ Transformed via {transformLabel}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleTransformUndo}
            style={[styles.replyBarClose, { paddingLeft: 12 }]}
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          >
            <Text style={{ color: c.primary, fontSize: 13, fontWeight: '600' }}>Undo</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Recording overlay (OpenChat-xxc / 9de).
          - HOLD mode: shows elapsed time + "slide to cancel" hint.
          - LOCKED (hands-free) mode: shows elapsed time + Cancel and Stop
            buttons so the user can finish without holding. */}
      {isRecording && (
        <View style={[styles.recordingBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={[styles.recordingDot, { backgroundColor: '#ef4444' }]} />
          <Text style={{ color: c.textPrimary, fontSize: 14, fontWeight: '500', marginLeft: 8 }}>
            {(() => {
              const totalSec = Math.floor(recordingElapsedMs / 1000);
              const min = Math.floor(totalSec / 60);
              const sec = totalSec % 60;
              return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
            })()}
          </Text>
          {recordingLocked ? (
            <>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                onPress={() => void finishRecording(true)}
                style={{ paddingHorizontal: 12, paddingVertical: 6 }}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                accessibilityLabel="Cancel voice message"
              >
                <Text style={{ color: c.textMuted, fontSize: 14, fontWeight: '500' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void finishRecording(false)}
                style={[styles.recordingStopBtn, { backgroundColor: c.primary }]}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                accessibilityLabel="Stop and send voice message"
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Send</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={{ color: c.textMuted, fontSize: 12, marginLeft: 12 }}>
              {'← Slide to cancel · tap mic for hands-free'}
            </Text>
          )}
        </View>
      )}

      {/* Cancel feedback — shown briefly after drag-cancel (OpenChat-xxc) */}
      {recordingCancelled && (
        <View style={[styles.recordingBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <AppIcon name="trash" color={c.textMuted} size={15} />
          <Text style={{ color: c.textMuted, fontSize: 14, marginLeft: 8 }}>Recording cancelled</Text>
        </View>
      )}

      <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border }]}>
        {/* Attachment pick button (OpenChat-6bg) — hidden in edit mode or while recording */}
        {!editingMessage && !isRecording && (
          <TouchableOpacity
            onPress={handlePickAttachment}
            disabled={sending || uploadingAttachment}
            style={[styles.attachBtn, { opacity: sending || uploadingAttachment ? 0.4 : 1 }]}
            accessibilityLabel="Attach image"
          >
            <AppIcon name="attach" color={c.textSecondary} size={22} />
          </TouchableOpacity>
        )}
        <TextInput
          ref={textInputRef}
          style={[styles.input, { backgroundColor: 'transparent', color: c.textPrimary, borderBottomColor: c.border }]}
          value={text}
          onChangeText={handleTextChange}
          placeholder="Write…"
          placeholderTextColor={c.textMuted}
          multiline
          // Web (/m, /d): Enter sends, Shift+Enter inserts a newline. Guarded to
          // web only — on a touch keyboard the return key must stay a newline
          // (sending is the send button). The isComposing check keeps IME users
          // (e.g. Chinese input) from sending while confirming a candidate.
          // See openchat-4hq.
          onKeyPress={(e) => {
            if (Platform.OS !== 'web') return;
            const ne = e.nativeEvent as unknown as KeyboardEvent;
            if (ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        {/* Transform sparkle button (OpenChat-8a0) — hidden in edit mode or while recording */}
        {!editingMessage && !isRecording && (
          <TransformButton
            text={text}
            disabled={!text.trim() || sending}
            onTransformed={handleTransformed}
            onError={showToast}
          />
        )}
        {/* NVC composer button (OpenChat-3kr.2) — opens the 4-field
            Observation/Feeling/Need/Request scaffold modal. Hidden in
            edit mode or while voice-recording. */}
        {!editingMessage && !isRecording && (
          <TouchableOpacity
            onPress={() => setNvcVisible(true)}
            disabled={sending}
            style={{ paddingHorizontal: 8, paddingVertical: 8, opacity: sending ? 0.4 : 1 }}
            accessibilityLabel="NVC compose"
          >
            <AppIcon name="heart" color={c.primary} size={19} />
          </TouchableOpacity>
        )}
        {/*
          Mic button (OpenChat-xxc): shown on native when text is empty and not editing.
          Hold to record; drag left > 80px to cancel.
          On web, always hidden (Platform.OS === 'web').
        */}
        {!editingMessage && !text.trim() && !pendingAsset && Platform.OS !== 'web' && (
          <View
            onTouchStart={(e) => { void handleMicPressIn(e.nativeEvent.pageX); }}
            onTouchEnd={() => { void handleMicPressOut(false); }}
            onTouchMove={(e) => {
              const dx = micPressStartXRef.current - e.nativeEvent.pageX;
              if (dx > CANCEL_DRAG_PX && isRecording) {
                void handleMicPressOut(true);
              }
            }}
            onTouchCancel={() => { void handleMicPressOut(true); }}
            style={[
              styles.send,
              {
                backgroundColor: isRecording ? '#ef4444' : c.primary,
                opacity: sending ? 0.5 : 1,
                alignItems: 'center',
                justifyContent: 'center',
              },
            ]}
            accessible
            accessibilityLabel="Hold to record voice message"
            accessibilityRole="button"
          >
            <AppIcon name={isRecording ? 'stop' : 'mic'} color="#fff" size={19} />
          </View>
        )}
        {/* Send button: shown when there is text or a pending asset */}
        {(!!text.trim() || !!pendingAsset || editingMessage) && (
          <TouchableOpacity
            style={[styles.send, { backgroundColor: c.primary, opacity: (!text.trim() && !pendingAsset) || sending ? 0.5 : 1 }]}
            onPress={handleSend}
            disabled={(!text.trim() && !pendingAsset) || sending}
            accessibilityLabel="Send message"
          >
            {(sending && uploadingAttachment) ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontWeight: '600' }}>Send</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Fullscreen image viewer modal (OpenChat-6bg) */}
      <Modal
        visible={!!fullscreenImage}
        transparent
        animationType="fade"
        onRequestClose={() => setFullscreenImage(null)}
      >
        <TouchableOpacity
          style={styles.fullscreenOverlay}
          activeOpacity={1}
          onPress={() => setFullscreenImage(null)}
        >
          {fullscreenImage && (
            <Image
              source={{ uri: fullscreenImage }}
              style={styles.fullscreenImage}
              resizeMode="contain"
            />
          )}
          <TouchableOpacity
            style={styles.fullscreenClose}
            onPress={() => setFullscreenImage(null)}
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          >
            <Text style={{ color: '#fff', fontSize: 28, lineHeight: 32 }}>×</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Message action sheet (OpenChat-uxj, OpenChat-46p, OpenChat-wgl, OpenChat-q9h, OpenChat-7bd, OpenChat-hhc) */}
      <MessageActionSheet
        visible={actionSheetVisible}
        message={actionSheetMessage}
        isOwn={actionSheetIsOwn}
        senderName={actionSheetSenderName}
        onDismiss={() => setActionSheetVisible(false)}
        onReply={handleReply}
        onForward={handleForward}
        onForwardToAssistant={handleForwardToAssistant}
        onAskAssistant={handleAskAssistant}
        onSaveToThoughts={handleSaveToThoughts}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onReact={handleReact}
        onBlock={handleBlock}
        onReport={handleReport}
      />

      {/* In-app toast for report confirmation */}
      <ToastMessage visible={toastVisible} message={toastMsg} />

      {/* NVC composer modal (OpenChat-3kr.2). On submit it stuffs the
          assembled message into the composer's `text` state — the user can
          still tweak before tapping Send, OR they can pre-empt that and we
          send immediately. Default: stuff and let user hit Send so they
          have one more chance to revise (NVC self-empathy moment). */}
      <NVCComposerModal
        visible={nvcVisible}
        onCancel={() => setNvcVisible(false)}
        onSubmit={(assembled) => {
          setText(assembled);
          setNvcVisible(false);
          // Focus the composer so the user can revise before sending.
          setTimeout(() => textInputRef.current?.focus(), 80);
        }}
      />
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
    // maxWidth is controlled by the column wrapper that also contains ReactionsBar
    width: '100%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  sender: { fontSize: 12, marginBottom: 2, fontWeight: '500' },
  forwardedLabel: { fontSize: 11, fontStyle: 'italic', marginBottom: 3 },
  bubbleFooter: { marginTop: 4, flexDirection: 'row', alignItems: 'center' },
  dayWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
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
    paddingHorizontal: 4,
    paddingVertical: 9,
    borderRadius: 0,
    borderWidth: 0,
    borderBottomWidth: 1.5,
    fontSize: 16,
    minHeight: 40,
    maxHeight: 120,
  },
  send: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
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
  // Attachment styles (OpenChat-6bg)
  attachmentPreviewBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attachmentPreviewThumb: {
    width: 48,
    height: 48,
    borderRadius: 6,
  },
  attachBtn: {
    paddingBottom: 6,
    paddingRight: 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  // Voice recording feedback bar (OpenChat-xxc)
  recordingBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  // Stop-and-send button shown in hands-free (locked) recording (OpenChat-9de)
  recordingStopBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 16,
    marginLeft: 4,
  },
  attachmentImage: {
    width: '100%',
    borderRadius: 10,
    overflow: 'hidden' as const,
  },
  fullscreenOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  fullscreenImage: {
    width: '100%',
    height: '100%',
  },
  fullscreenClose: {
    position: 'absolute' as const,
    top: 52,
    right: 20,
    width: 40,
    height: 40,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
});
