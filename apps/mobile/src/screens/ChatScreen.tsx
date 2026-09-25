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
  Linking,
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
import { ConversationLaneSwitch } from '../components/ConversationLaneSwitch';
import { ContextLane } from '../components/ContextLane';
import { ContextComposer } from '../components/ContextComposer';
import { useSocialExperience } from '../contexts/SocialExperienceContext';
import { useRecording } from '../contexts/RecordingContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { AiDisclosureBanner } from '../components/AiDisclosureBanner';
import { AppIcon } from '../components/AppIcon';
import { ConversationHeaderContent } from '../components/ConversationHeaderContent';
import { isPlaceholderEmail } from '../utils/email';
import { NewMessagesPill } from '../components/NewMessagesPill';
import { ChatEmptyState } from '../components/ChatEmptyState';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { NavProp, RouteProps } from '../navigation/types';
import { setActiveConversationForNotifications } from '../services/notifications';
import { hapticSend, hapticReceive } from '../services/haptics';
import { colorForUserId } from '../utils/colorForUserId';
import { pickImage, uploadImage, PickedAsset } from '../services/attachments';
import { VoiceMessageBubble } from '../components/VoiceMessageBubble';
import { MentionAutocomplete, MentionCandidate } from '../components/MentionAutocomplete';
import { HashtagAutocomplete } from '../components/HashtagAutocomplete';
import { TransformButton } from '../components/TransformButton';
import { NVCComposerModal } from '../components/NVCComposerModal';
import { LinkPreviewCard } from '../components/LinkPreviewCard';
import { AgentNetworkCard } from '../components/AgentNetworkCard';
import type { Participant } from '../api/client';
import { ExportSheet } from '../components/ExportSheet';
import { saveJsonDownload } from '../services/exportDownload';
import { logError } from '../services/clientLogger';
import {
  fetchHashtagSuggestions,
  HashtagSuggestion,
  invalidateHashtagSuggestions,
} from '../services/hashtagSuggestions';
import { buildConversationHeaderSubtitle } from '../utils/conversationHeader';
import {
  ActiveHashtag,
  applyHashtagSuggestion,
  findActiveHashtag,
} from '../utils/hashtagAutocomplete';
import {
  getDirectConversationParticipant,
  getDirectConversationTitle,
  getUserDisplayName,
  isSelfDirectConversation,
} from '../utils/conversationDisplay';
import { shouldShowGroupSenderLabel } from '../utils/conversationPresentation';

const TYPING_DEBOUNCE_MS = 2000; // auto-clear typing after this much silence

// ── Voice message constants (OpenChat-xxc) ─────────────────────────────────
const CANCEL_DRAG_PX = 80; // horizontal drag distance to cancel recording

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
  const nameMap = new Map<string, string | null>();
  for (const p of participants) {
    if (!p?.user?.id) continue;
    const displayName = getUserDisplayName(p.user);
    const key = displayName.toLowerCase();
    nameMap.set(key, nameMap.has(key) ? null : p.user.id);
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

function buildRows(messages: Message[], myId: string | undefined, isGroup: boolean): RenderRow[] {
  const out: RenderRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
      out.push({ type: 'day', key: `day-${m.createdAt}`, label: dayLabel(m.createdAt) });
    }
    const isOwn = m.senderId === myId;
    const previousSenderId = prev && sameDay(prev.createdAt, m.createdAt)
      ? prev.senderId
      : undefined;
    const showSender = shouldShowGroupSenderLabel(
      isGroup,
      isOwn,
      m.senderId,
      previousSenderId,
    );
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
 *   1. compact /app/ + native — as a stack screen via ChatsNavigator. Reads
 *      conversationId from the route, configures the native-stack header
 *      via navigation.setOptions.
 *   2. wide /app/ — embedded inside MasterDetailLayout's right pane. The parent
 *      passes conversationId via props and asks us to skip header setup
 *      via `embedded` (the master-detail provides its own chrome).
 *
 * Both contexts share the same body: the entire message thread, composer,
 * action sheet, reactions, transforms, voice / image / link previews,
 * mention autocomplete, etc. — keeping compact and wide layouts equivalent.
 */
interface ChatScreenProps {
  /** Override conversationId. Required when used outside the Chat route. */
  conversationId?: string;
  /** When true, skip navigation.setOptions (parent owns the chrome). */
  embedded?: boolean;
  /** Wide-layout hook that opens OpenChat Agent without replacing the chat pane. */
  onOpenAgent?: () => void;
}

export function ChatScreen({
  conversationId: conversationIdProp,
  embedded = false,
  onOpenAgent,
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
  const laneProp = routeRaw.name === 'Chat' ? ((routeRaw.params as any)?.lane as 'chat' | 'context' | undefined) : undefined;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { enhanced } = useSocialExperience();
  // Dynamic keyboard offset for KeyboardAvoidingView. This is the distance
  // from the top of the screen to the top of the KAV — i.e. the height of
  // the nav-stack header. `useHeaderHeight()` already INCLUDES the safe-area
  // top inset on notched devices; adding insets.top on top of it double-counts
  // (~47px on iPhone 14), causing KAV to overestimate keyboard intrusion and
  // leave an empty gap below the composer when the keyboard opens.
  const headerHeight = useHeaderHeight();
  const kbOffset = embedded ? 0 : Platform.OS === 'ios' ? headerHeight : 0;
  const {
    currentUser, conversations, messages: activeMessages, loadingMessages, isConnected,
    loadOlderMessages, hasMoreMessages, loadingOlderMessages,
    setActiveConversation, sendMessage, editMessage, deleteMessage, toggleReaction,
    presence, typingByConv, reportTyping,
    aiDisclosureAcceptedAt, mutedConvs, muteConv, blockUser,
    readByOthers, onlineUsers, markConversationRead,
    activeConversationLane, setActiveConversationLane,
  } = useChat();

  const conversation = useMemo<Conversation | undefined>(
    () => conversations.find(cv => cv.id === conversationId),
    [conversations, conversationId]
  );
  // ChatProvider's shared buffer can still hold the previous thread during
  // navigation. Never mount its media or trigger native feedback in this one.
  const messages = useMemo(
    () => activeMessages.filter(message => message.conversationId === conversationId),
    [activeMessages, conversationId]
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

  // ── Hashtag autocomplete state (openchat-05n) ─────────────────────────────
  const [activeHashtag, setActiveHashtag] = useState<ActiveHashtag | null>(null);
  const [hashtagSuggestions, setHashtagSuggestions] = useState<HashtagSuggestion[]>([]);
  const [hashtagSelectedIndex, setHashtagSelectedIndex] = useState(0);
  const [hashtagDismissed, setHashtagDismissed] = useState(false);
  const textInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<RenderRow>>(null);
  const typingTimer = useRef<NodeJS.Timeout | null>(null);

  // Fetching never sits in the input handler: a short debounce plus the
  // service cache keeps typing synchronous and makes offline failure silent.
  useEffect(() => {
    if (!activeHashtag || hashtagDismissed) {
      setHashtagSuggestions([]);
      setHashtagSelectedIndex(0);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchHashtagSuggestions(conversationId, activeHashtag.query)
        .then((suggestions) => {
          if (cancelled) return;
          setHashtagSuggestions(suggestions);
          setHashtagSelectedIndex(0);
        })
        .catch(() => {
          if (!cancelled) setHashtagSuggestions([]);
        });
    }, 160);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeHashtag?.query, activeHashtag?.start, conversationId, hashtagDismissed]);

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

  // ── Voice recording state (build-90 pieces 1+2) ────────────────────────────
  // The provider owns expo-av and all gesture timing so navigation cannot tear
  // down an active recording. This screen retains the existing composer UX.
  const {
    status: recordingStatus,
    conversationId: recordingConversationId,
    elapsedMs: recordingElapsedMs,
    locked: recordingLocked,
    finishing: finishingRecording,
    recentlyCancelled: recordingCancelled,
    beginPress: beginRecordingPress,
    endPress: endRecordingPress,
    stopAndSend: stopAndSendRecording,
    cancel: cancelActiveRecording,
    pressStartX: micPressStartXRef,
  } = useRecording();
  const isAnyRecording = recordingStatus === 'recording';
  const isRecording = isAnyRecording && recordingConversationId === conversationId;
  const composerBusy = sending || finishingRecording;

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
    if (laneProp) setActiveConversationLane(laneProp);
    setActiveConversationForNotifications(conversationId);
    // Mark as read when the user opens the conversation (OpenChat-0nj).
    if (!laneProp || laneProp === 'chat') markConversationRead(conversationId);
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
  }, [conversationId, setActiveConversation, markConversationRead, laneProp, setActiveConversationLane]);

  const isGroup = conversation?.type === 'group';
  // Resolve self-DMs deliberately: there is no "other" participant, so the
  // signed-in participant supplies the avatar while the title says "Myself".
  const isSelfDM = conversation
    ? isSelfDirectConversation(conversation, currentUser)
    : false;
  const other = conversation && !isGroup
    ? getDirectConversationParticipant(conversation, currentUser)
    : null;
  const groupAvatarMembers = useMemo(
    () => isGroup
      ? (conversation?.participants || [])
          .flatMap(participant => participant?.user?.id
            && participant.user.id !== currentUser?.userId
            ? [participant.user]
            : [])
      : [],
    [conversation?.participants, currentUser?.userId, isGroup],
  );
  const directPresenceText = other
    ? (other.profileStatus 
        ? `${other.profileStatus.emoji ? other.profileStatus.emoji + ' ' : ''}${other.profileStatus.text || ''}`.trim() || presence.get(other.id)?.statusMessage || presence.get(other.id)?.status || other.presenceStatus || ''
        : presence.get(other.id)?.statusMessage || presence.get(other.id)?.status || other.presenceStatus || '')
    : '';

  // Participants eligible for @-mention — all except self (OpenChat-0jy).
  const mentionableParticipants = useMemo(() => {
    if (!isGroup) return [];
    return (conversation?.participants || []).filter(
      p => !!p?.user?.id && p.user.id !== currentUser?.userId
    );
  }, [isGroup, conversation?.participants, currentUser?.userId]);
  const headerTitle = useMemo(() => {
    if (!conversation) return '';
    if (!isGroup) {
      if (!isSelfDM && !conversation.title
        && other?.isBot && (other.id === 'assistant' || other.name === 'Assistant')) {
        return 'OpenChat Agent';
      }
      return getDirectConversationTitle(conversation, currentUser, 'Chat');
    }
    if (conversation.title) return conversation.title;
    const others = (conversation.participants || [])
      .filter(p => p?.user?.id !== currentUser?.userId)
      .map(p => getUserDisplayName(p?.user));
    if (others.length === 0) return 'Group';
    if (others.length <= 2) return others.join(', ');
    return `${others[0]} +${others.length - 1}`;
  }, [conversation, isGroup, isSelfDM, other, currentUser]);

  // Does this conversation include any bot participant? (OpenChat-ds3)
  const containsBot = useMemo(
    () => conversation?.participants?.some(p => p?.user?.isBot) ?? false,
    [conversation]
  );

  // Mute menu logic (OpenChat-aes)
  const isMuted = !!mutedConvs[conversationId];
  const [conversationMenuVisible, setConversationMenuVisible] = useState(false);
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

  const headerSubtitle = useMemo(() => buildConversationHeaderSubtitle({
    directStatus: directPresenceText,
    isGroup,
    isSelfDM,
    memberCount: conversation?.participants?.length || 0,
    containsBot,
    isMuted,
  }), [conversation?.participants?.length, containsBot, directPresenceText, isGroup, isMuted, isSelfDM]);

  const openConversationInfo = useCallback(() => {
    if (isGroup) navigation.navigate('GroupSettings', { conversationId });
    else if (isSelfDM) navigation.navigate('ProfileEdit');
    else if (other?.id) navigation.navigate('ContactProfile', { userId: other.id });
  }, [conversationId, isGroup, isSelfDM, navigation, other?.id]);

  const openConversationThoughts = useCallback(() => {
    setConversationMenuVisible(false);
    navigation.navigate('ConversationThoughts', { conversationId, title: headerTitle });
  }, [conversationId, headerTitle, navigation]);

  const openAgentNetwork = useCallback(() => {
    setConversationMenuVisible(false);
    (onOpenAgent ?? (() => navigation.navigate('AgentOverlay')))();
  }, [navigation, onOpenAgent]);

  const showMuteOptions = useCallback(() => {
    setConversationMenuVisible(false);
    if (isMuted) {
      void muteConv(conversationId, null);
      return;
    }

    if (Platform.OS === 'ios') {
      const options = ['Mute for 1 hour', 'Mute for 8 hours', 'Mute until tomorrow', 'Mute always', 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: 4 },
        (idx) => {
          if (idx === 4) return;
          const now = new Date();
          let until: Date | 'always';
          if (idx === 0) until = new Date(now.getTime() + 60 * 60 * 1000);
          else if (idx === 1) until = new Date(now.getTime() + 8 * 60 * 60 * 1000);
          else if (idx === 2) {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            until = tomorrow;
          } else until = 'always';
          void muteConv(conversationId, until);
        }
      );
    } else {
      Alert.alert(
        'Mute conversation?',
        'You will stop receiving notification banners for this chat.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Mute always', onPress: () => void muteConv(conversationId, 'always') },
        ]
      );
    }
  }, [conversationId, isMuted, muteConv]);

  const openExport = useCallback(() => {
    setConversationMenuVisible(false);
    setExportSheetVisible(true);
  }, []);

  const moreAction = (
    <TouchableOpacity
      onPress={() => setConversationMenuVisible(true)}
      accessibilityRole="button"
      accessibilityLabel="More conversation actions"
      style={styles.headerMoreAction}
    >
      <AppIcon name="more" color={c.textSecondary} size={20} />
    </TouchableOpacity>
  );

  useLayoutEffect(() => {
    // Embedded in MasterDetailLayout — the parent owns the chrome.
    if (embedded) return;
    const safeOtherEmail = isPlaceholderEmail(other?.email) ? '' : other?.email;
    navigation.setOptions({
      headerTitle: () => (
        <ConversationHeaderContent
          title={headerTitle}
          subtitle={headerSubtitle}
          avatarName={!isGroup ? (other?.name || safeOtherEmail || headerTitle) : headerTitle}
          avatarEmail={safeOtherEmail || undefined}
          avatarUrl={!isGroup ? other?.avatarUrl : undefined}
          isBot={!isGroup ? other?.isBot : false}
          variant={isGroup ? 'group' : 'person'}
          groupMembers={groupAvatarMembers}
          onPress={(isGroup || isSelfDM || other?.id) ? openConversationInfo : undefined}
        />
      ),
      headerRight: () => moreAction,
    });
  }, [embedded, navigation, isGroup, isSelfDM, headerTitle, headerSubtitle, other, groupAvatarMembers, openConversationInfo, c.textSecondary]);

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
    const built = buildRows(messages, currentUser?.userId, isGroup);
    // Rebuild messageId → row index map for scroll-to-quoted.
    const map = new Map<string, number>();
    built.forEach((r, i) => {
      if (r.type === 'message' && r.message) map.set(r.message.id, i);
    });
    messageIndexRef.current = map;
    return built;
  }, [messages, currentUser?.userId, isGroup]);

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

  // Only an appended live message warrants native receive feedback. Opening
  // a group hydrates history; pagination and edits are not incoming messages.
  const receivedMessagesRef = useRef<{
    conversationId: string;
    latestId: string | undefined;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    const latest = messages[messages.length - 1];
    const previous = receivedMessagesRef.current;
    receivedMessagesRef.current = { conversationId, latestId: latest?.id, loading: loadingMessages };
    if (latest && (previous?.conversationId !== conversationId || previous.latestId !== latest.id)) {
      if (activeConversationLane === 'chat') {
        markConversationRead(conversationId);
      }
    }
    if (!previous || previous.conversationId !== conversationId
      || loadingMessages || previous.loading || !latest
      || latest.id === previous.latestId) return;
    // A replacement history page or removal of the last message is not an
    // append. The former newest message must still exist in this thread.
    if (previous.latestId && !messages.some(message => message.id === previous.latestId)) return;
    if (latest.senderId && latest.senderId !== currentUser?.userId) hapticReceive();
  }, [messages, loadingMessages, currentUser?.userId, conversationId, markConversationRead, activeConversationLane]);

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
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      if (isAtBottomRef.current) {
        // Defer past the layout animation so contentSize reflects the new
        // (smaller) layout before we scroll.
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setMentionQuery(null);
      setHashtagDismissed(true);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleTextChange = (next: string) => {
    setText(next);
    // onChangeText does not carry the caret offset. Most changes append at the
    // end, so update immediately for that fast path; onSelectionChange below
    // corrects this after edits in the middle of a draft.
    setActiveHashtag(findActiveHashtag(next, next.length));
    setHashtagDismissed(false);
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

  const handleHashtagSelect = useCallback((suggestion: HashtagSuggestion) => {
    if (!activeHashtag) return;
    const applied = applyHashtagSuggestion(text, activeHashtag, suggestion.tag);
    setText(applied.text);
    setActiveHashtag(null);
    setHashtagSuggestions([]);
    setHashtagSelectedIndex(0);
    setHashtagDismissed(true);

    // Keep the software keyboard open after a tap and place the caret after
    // the inserted space so mobile composition continues without another tap.
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.setNativeProps({
        selection: { start: applied.cursor, end: applied.cursor },
      });
    });
  }, [activeHashtag, text]);

  // ── Attachment pick handler (OpenChat-6bg) ────────────────────────────────
  const handlePickAttachment = useCallback(async () => {
    if (composerBusy || uploadingAttachment) return;
    const asset = await pickImage();
    if (asset) setPendingAsset(asset);
  }, [composerBusy, uploadingAttachment]);

  // ── Voice recording handlers (OpenChat-xxc) ──────────────────────────────

  /** Called when the mic button is pressed in. Starts the global recording. */
  const handleMicPressIn = useCallback(async (pageX: number) => {
    if (composerBusy || uploadingAttachment || Platform.OS === 'web') return;
    await beginRecordingPress(
      conversationId,
      headerTitle || 'Chat',
      pageX,
      replyTo?.messageId,
      () => setReplyTo(null)
    );
  }, [
    beginRecordingPress,
    conversationId,
    headerTitle,
    replyTo?.messageId,
    composerBusy,
    uploadingAttachment,
  ]);

  /**
   * Called when the finger lifts off the mic button. Distinguishes a TAP (short
   * press → hands-free locked recording) from a HOLD (record-while-held → send
   * on release). A drag-cancel passes wasCancelled=true. (OpenChat-9de)
   */
  const handleMicPressOut = useCallback(async (wasCancelled: boolean) => {
    await endRecordingPress(wasCancelled);
  }, [endRecordingPress]);

  const finishRecording = useCallback(async (wasCancelled: boolean) => {
    if (wasCancelled) {
      await cancelActiveRecording();
      return;
    }
    const sent = await stopAndSendRecording();
    if (sent) setReplyTo(null);
  }, [cancelActiveRecording, stopAndSendRecording]);

  const handleSend = async () => {
    const trimmed = text.trim();
    const hasAttachment = !!pendingAsset;
    if ((!trimmed && !hasAttachment) || composerBusy) return;
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
    setActiveHashtag(null);
    setHashtagSuggestions([]);
    setHashtagDismissed(true);
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
      invalidateHashtagSuggestions(conversationId);
      hapticSend();
    } catch (err) {
      console.warn('[ChatScreen] send failed:', err);
      Alert.alert('Upload failed', 'Could not send the image. Please try again.');
    } finally {
      setSending(false);
    }
  };

  // React Native's onKeyPress only reliably covers character keys on web.
  // RN Web forwards onKeyDown to its underlying textarea, which is what lets
  // arrow, Tab, and Escape controls work without a global document listener.
  const handleComposerWebKeyDown = (event: React.KeyboardEvent) => {
    const hashtagPickerOpen = !!activeHashtag
      && !hashtagDismissed
      && hashtagSuggestions.length > 0;

    if (hashtagPickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        setHashtagSelectedIndex((index) => (index + 1) % hashtagSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        setHashtagSelectedIndex(
          (index) => (index - 1 + hashtagSuggestions.length) % hashtagSuggestions.length,
        );
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault();
        handleHashtagSelect(hashtagSuggestions[hashtagSelectedIndex]);
        return;
      }
    }
    if (event.key === 'Escape' && activeHashtag) {
      event.preventDefault();
      setHashtagDismissed(true);
      setHashtagSuggestions([]);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSend();
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
  const beginEdit = useCallback((message: Message) => {
    setEditingMessage(message);
    setReplyTo(null);
    setText(message.content);
  }, []);

  const handleEdit = useCallback((message: Message) => {
    // Recording is lightly modal, like every messenger: while a voice note is
    // live, Edit just nudges instead of interrupting (no dialogs, no silent
    // discard — the recording keeps going). See 2026-09-02 discussion; the
    // The recording may have started in another chat; editing remains blocked
    // until it is sent or cancelled (build-90 pieces 1+2).
    if (isAnyRecording) {
      showToast('Voice note in progress — send or cancel it first');
      return;
    }
    beginEdit(message);
  }, [beginEdit, isAnyRecording, showToast]);

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
      .map(uid => getUserDisplayName(conversation.participants?.find(p => p?.user?.id === uid)?.user));
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

  // One row = one server-supplied message. Extracted from the FlatList so each
  // row can sit inside its own ErrorBoundary: a malformed message then renders a
  // placeholder instead of taking down the whole app (openchat-dwk).
  const renderMessageRow = (item: RenderRow) => {
    if (item.type === 'day') {
      return (
        <View style={styles.dayWrap}>
          <View style={[styles.dayLine, { backgroundColor: c.divider }]} />
          <Text style={[styles.dayLabel, { color: c.textMetadata }]}>{item.label}</Text>
          <View style={[styles.dayLine, { backgroundColor: c.divider }]} />
        </View>
      );
    }
    const m = item.message!;
    if (m.messageType === 'card') {
      return (
        <AgentNetworkCard
          message={m}
          onOpenConversation={(matchedConversationId) => {
            navigation.navigate('Chat', { conversationId: matchedConversationId });
          }}
          onShareDraft={(draftId, initialText) => {
            navigation.navigate('StoryComposer', { draftId, initialText });
          }}
        />
      );
    }
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
                name={getUserDisplayName(m.sender)}
                email={m.sender?.email}
                avatarUrl={m.sender?.avatarUrl}
                size={28}
              />
            )}
          </View>
        )}
        {/* Column wrapper so ReactionsBar renders below the bubble */}
        <View style={{ flexDirection: 'column', maxWidth: '78%', alignItems: isOwn ? 'flex-end' : 'flex-start' }}>
        <TouchableOpacity
          activeOpacity={0.85}
          onLongPress={() => handleLongPress(m, isOwn, getUserDisplayName(m.sender))}
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
                {getUserDisplayName(m.replyTo?.sender)}
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
            <Text style={[styles.forwardedLabel, { color: isOwn ? ownTint(0.78) : c.textMetadata }]}>
              ◇ Secretary auto-reply
            </Text>
          )}
          {!!m.forwardedFromMessageId && (
            <Text style={[styles.forwardedLabel, { color: isOwn ? ownTint(0.7) : c.textMetadata }]} numberOfLines={1}>
              {'↪ Forwarded from '}{m.forwardedFromSenderName || 'Unknown'}
            </Text>
          )}
          {item.showSender && (
            <Text style={[
              styles.sender,
              { color: isGroup ? senderColor : c.textSecondary },
            ]}>
              {getUserDisplayName(m.sender)}
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
                    <Text style={{ fontSize: 13, fontStyle: 'italic', color: isOwn ? ownTint(0.6) : c.textMetadata, marginBottom: 4 }}>
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
            ? <Text style={{ color: isOwn ? ownTint(0.55) : c.textMetadata, fontSize: 15, fontStyle: 'italic' }}>Message deleted</Text>
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
            <Text style={{ color: isOwn ? ownTint(0.7) : c.textMetadata, fontSize: 10 }}>
              {failed ? 'Failed to send' : formatTime(m.createdAt)}
            </Text>
            {/* Edited tag (OpenChat-q9h) */}
            {!!(m.editedAt && !m.deletedAt) && (
              <Text style={{ color: isOwn ? ownTint(0.6) : c.textMetadata, fontSize: 10, marginLeft: 4, fontStyle: 'italic' }}>edited</Text>
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
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
      keyboardVerticalOffset={kbOffset}
    >
      {embedded && (() => {
        const safeOtherEmail = isPlaceholderEmail(other?.email) ? '' : other?.email;
        return (
          <View style={[styles.embeddedHeader, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
            <ConversationHeaderContent
              title={headerTitle}
              subtitle={headerSubtitle}
              avatarName={!isGroup ? (other?.name || safeOtherEmail || headerTitle) : headerTitle}
              avatarEmail={safeOtherEmail || undefined}
              avatarUrl={!isGroup ? other?.avatarUrl : undefined}
              isBot={!isGroup ? other?.isBot : false}
              variant={isGroup ? 'group' : 'person'}
              groupMembers={groupAvatarMembers}
              avatarSize={34}
              minHeight={64}
              onPress={(isGroup || isSelfDM || other?.id) ? openConversationInfo : undefined}
              action={moreAction}
            />
          </View>
        );
      })()}
      <ConversationLaneSwitch activeLane={activeConversationLane} onChange={setActiveConversationLane} />
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

      <Modal
        visible={conversationMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setConversationMenuVisible(false)}
      >
        <View style={styles.conversationMenuBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setConversationMenuVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Close conversation actions"
          />
          <View
            style={[styles.conversationMenuSheet, { backgroundColor: c.surface, borderColor: c.border }]}
            accessibilityRole="menu"
            accessibilityLabel="Conversation actions"
          >
            <Text style={[styles.conversationMenuTitle, { color: c.textPrimary }]} numberOfLines={1}>
              {headerTitle || 'Chat'}
            </Text>
            <TouchableOpacity onPress={openConversationThoughts} style={styles.conversationMenuRow} accessibilityRole="menuitem">
              <AppIcon name="thought" color={c.primary} size={20} />
              <Text style={[styles.conversationMenuLabel, { color: c.textPrimary }]}>Thoughts for this chat</Text>
            </TouchableOpacity>
            {enhanced && (
              <TouchableOpacity onPress={openAgentNetwork} style={styles.conversationMenuRow} accessibilityRole="menuitem">
                <AppIcon name="bot" color={c.primary} size={20} />
                <Text style={[styles.conversationMenuLabel, { color: c.textPrimary }]}>Agent network</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={showMuteOptions} style={styles.conversationMenuRow} accessibilityRole="menuitem">
              <AppIcon name="mute" color={c.textMetadata} size={19} strokeWidth={1.8} />
              <Text style={[styles.conversationMenuLabel, { color: c.textPrimary }]}>{isMuted ? 'Unmute' : 'Mute'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openExport} style={styles.conversationMenuRow} accessibilityRole="menuitem">
              <AppIcon name="download" color={c.textMetadata} size={19} />
              <Text style={[styles.conversationMenuLabel, { color: c.textPrimary }]}>Export conversation</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setConversationMenuVisible(false)}
              style={[styles.conversationMenuCancel, { borderTopColor: c.border }]}
              accessibilityRole="button"
            >
              <Text style={[styles.conversationMenuLabel, { color: c.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {activeConversationLane === 'context' ? (
        <View style={{ flex: 1 }}>
          <ContextLane conversationId={conversationId} />
          <ContextComposer conversationId={conversationId} />
        </View>
      ) : (
        <>
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
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
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
          renderItem={({ item }) => (
            <ErrorBoundary
              scope="chat-message"
              resetKey={item.key}
              render={() => renderMessageRow(item)}
              fallback={() => (
                <View style={styles.dayWrap}>
                  <Text style={[styles.dayLabel, { color: c.textMetadata }]}>
                    Message unavailable
                  </Text>
                </View>
              )}
            />
          )}
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

      {activeHashtag && !hashtagDismissed && hashtagSuggestions.length > 0 && (
        <HashtagAutocomplete
          suggestions={hashtagSuggestions}
          selectedIndex={hashtagSelectedIndex}
          onSelect={handleHashtagSelect}
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
                <Text style={{ color: c.textMetadata, fontSize: 14, fontWeight: '500' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void finishRecording(false)}
                style={[styles.recordingStopBtn, { backgroundColor: c.primary }]}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                accessibilityLabel="Stop and send voice message"
              >
                <Text style={{ color: c.onPrimary, fontSize: 13, fontWeight: '600' }}>Send</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={{ color: c.textMetadata, fontSize: 12, marginLeft: 12 }}>
              {'← Slide to cancel · tap mic for hands-free'}
            </Text>
          )}
        </View>
      )}

      {/* Cancel feedback — shown briefly after drag-cancel (OpenChat-xxc) */}
      {recordingCancelled && (
        <View style={[styles.recordingBar, { backgroundColor: c.surface, borderColor: c.border }]}>
          <AppIcon name="trash" color={c.textMuted} size={15} />
          <Text style={{ color: c.textMetadata, fontSize: 14, marginLeft: 8 }}>Recording cancelled</Text>
        </View>
      )}

      <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border }]}>
        {/* Attachment pick button (OpenChat-6bg) — hidden in edit mode or while recording */}
        {!editingMessage && !isRecording && (
          <TouchableOpacity
            onPress={handlePickAttachment}
            disabled={composerBusy || uploadingAttachment}
            style={[styles.attachBtn, { opacity: composerBusy || uploadingAttachment ? 0.4 : 1 }]}
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
          {...(Platform.OS === 'web' ? { onKeyDown: handleComposerWebKeyDown } : {})}
          onSelectionChange={(event) => {
            const cursor = event.nativeEvent.selection.end;
            setActiveHashtag(findActiveHashtag(text, cursor));
            setHashtagDismissed(false);
          }}
          // Web (/app): Enter sends, Shift+Enter inserts a newline. Native
          // touch keyboards keep return as newline and use the send button.
        />
        {/* Transform sparkle button (OpenChat-8a0) — hidden in edit mode or
            while recording. The chevron menu includes "NVC Compose...",
            which opens the 4-field Observation/Feeling/Need/Request
            scaffold modal (OpenChat-3kr.2) instead of running an AI
            rewrite. */}
        {!editingMessage && !isRecording && (
          <TransformButton
            text={text}
            disabled={!text.trim() || composerBusy}
            onTransformed={handleTransformed}
            onError={showToast}
            onNvcCompose={() => setNvcVisible(true)}
          />
        )}
        {/*
          Mic button (OpenChat-xxc): shown on native when text is empty and not editing.
          Hold to record; drag left > 80px to cancel.
          On web, always hidden (Platform.OS === 'web').
        */}
        {!editingMessage && !text.trim() && !pendingAsset && Platform.OS !== 'web'
          && (!isAnyRecording || isRecording) && (
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
                opacity: composerBusy ? 0.5 : 1,
                alignItems: 'center',
                justifyContent: 'center',
              },
            ]}
            accessible
            accessibilityLabel="Hold to record voice message"
            accessibilityRole="button"
          >
            <AppIcon name={isRecording ? 'stop' : 'mic'} color={isRecording ? '#fff' : c.onPrimary} size={19} />
          </View>
        )}
        {/* Send button: shown when there is text or a pending asset */}
        {(!!text.trim() || !!pendingAsset || editingMessage) && (
          <TouchableOpacity
            style={[styles.send, { backgroundColor: c.primary, opacity: (!text.trim() && !pendingAsset) || composerBusy ? 0.5 : 1 }]}
            onPress={handleSend}
            disabled={(!text.trim() && !pendingAsset) || composerBusy}
            accessibilityLabel="Send message"
          >
            {(sending && uploadingAttachment) ? (
              <ActivityIndicator size="small" color={c.onPrimary} />
            ) : (
              <Text style={{ color: c.onPrimary, fontWeight: '600' }}>Send</Text>
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
      </>
      )}
      </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  embeddedHeader: {
    minHeight: 64,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingLeft: 16,
    paddingRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerMoreAction: {
    width: 44,
    minWidth: 44,
    minHeight: 44,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conversationMenuBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  conversationMenuSheet: {
    margin: 12,
    paddingTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    overflow: 'hidden',
  },
  conversationMenuTitle: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    fontWeight: '700',
  },
  conversationMenuRow: {
    minHeight: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  conversationMenuCancel: {
    minHeight: 48,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  conversationMenuLabel: { fontSize: 16, fontWeight: '500' },
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
