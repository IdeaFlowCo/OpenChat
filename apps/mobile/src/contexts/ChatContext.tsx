import { contextLaneManager } from '../services/contextLane';
import { isUnlinkedEmbed } from '../services/unlinkedEmbed';
/**
 * ChatContext — the single source of truth for socket lifecycle, conversations,
 * presence, typing, and unread counts in the mobile app.
 *
 * The native and responsive-web screens consume `useChat()` for state and
 * actions; they shouldn't subscribe to socket events directly.
 *
 * Reconnect catch-up (OpenChat-qz0): on socket reconnect (not first connect),
 * we call GET /api/chat/messages/since to fetch messages missed during the
 * disconnect window and merge them into local state.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import { OfflineChat, retryableSendError, type PendingMessage } from '../services/offlineChat';
import {
  setUnreadBadgeCount,
  setActiveConversationForNotifications,
  loadMutedConvs,
  muteConversation as muteConvStorage,
} from '../services/notifications';
import {
  api,
  AgentMatch,
  Attachment,
  Conversation,
  CurrentUser,
  LinkPreview,
  Message,
  ReactionSummary,
  User,
  getUser,
  getToken,
  isDroppedMessageSend,
  setSession,
  clearSession,
  onAuthExpired,
} from '../api/client';
import {
  connect,
  disconnect,
  emitPresenceUpdate,
  emitTypingStart,
  emitTypingStop,
  getSocket,
  joinConversation,
  leaveConversation,
  sendMessage as wsSend,
  ConversationEvent,
  ParticipantEvent,
  PresenceEvent,
  TypingEvent,
  MatchEvent,
} from '../api/socket';
import { showInAppBanner } from '../components/InAppMessageBanner';
import {
  applyMessageToConversationList,
  sortConversationsByRecent,
  unreadCountsFromConversations,
  upsertConversation,
} from './conversationState';
import { conversationLastMessage } from '../utils/conversationPresentation';
import { markIdeaflowAccountChoice } from '../services/ideaflowSignIn';
import { markIdeaflowAccountChoiceNative } from '../services/ideaflowNativeSignIn';
import { clearIdeaflowSignedOut, markIdeaflowSignedOut } from '../services/ideaflowAutoSignIn';

type Status = 'available' | 'away' | 'busy' | 'invisible';

interface ChatContextValue {
  // Identity / session
  currentUser: CurrentUser | null;
  isAuthed: boolean;
  authInitialized: boolean;
  isConnected: boolean;

  // Conversations
  conversations: Conversation[];
  conversationsLoaded: boolean;
  refreshConversations: () => Promise<void>;
  createConversation: (
    participantIds: string[],
    opts?: { title?: string; type?: 'direct' | 'group' }
  ) => Promise<Conversation>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  addParticipant: (conversationId: string, userId: string) => Promise<void>;
  removeParticipant: (conversationId: string, userId: string) => Promise<void>;

  // Active conversation (open thread)
  activeConversationId: string | null;
  activeConversationLane: 'chat' | 'context';
  setActiveConversationLane: (lane: 'chat' | 'context') => void;
  isChatVisible: (id: string) => boolean;
  registerConversationVisibility: (id: string) => () => void;
  setActiveConversation: (id: string | null, opts?: { lane?: 'chat' | 'context' }) => void;
  messages: Message[]; // for the active conversation
  loadingMessages: boolean;
  messageLoadError: string | null;
  retryMessages: () => void;
  loadOlderMessages: (conversationId: string) => Promise<void>;
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  sendMessage: (content: string, replyToId?: string, attachments?: Attachment[]) => Promise<void>;
  sendMessageToConversation: (
    conversationId: string,
    content: string,
    replyToId?: string,
    attachments?: Attachment[]
  ) => Promise<void>;

  retryPendingMessage: (clientId: string) => Promise<void>;
  discardPendingMessage: (clientId: string) => Promise<void>;

  // Edit / delete messages (OpenChat-q9h)
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;

  // Reactions (OpenChat-7bd)
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;

  // Block (OpenChat-46p)
  blockUser: (userId: string) => Promise<void>;

  // Presence & typing
  presence: Map<string, { status: string; statusMessage?: string; profileStatus?: { text?: string | null; emoji?: string | null } | null }>;
  typingByConv: Map<string, Set<string>>;
  reportTyping: (conversationId: string, isTyping: boolean) => void;

  // Unread counters
  unreadByConv: Map<string, number>;

  // Agent network — always privacy-safe per-viewer projections.
  matches: Map<string, AgentMatch>;
  pendingMatchCount: number;
  refetchMatches: () => Promise<void>;
  respondToAgentMatch: (id: string, decision: 'approve' | 'decline') => Promise<AgentMatch>;

  // AI disclosure (OpenChat-ds3)
  aiDisclosureAcceptedAt: string | null;
  acceptAiDisclosure: () => Promise<void>;

  // Mute (OpenChat-aes) — local-only until server endpoint exists
  mutedConvs: Record<string, string>; // convId → ISO expiry or 'always'
  muteConv: (convId: string, until: Date | 'always' | null) => Promise<void>;

  // Read receipts (OpenChat-0nj)
  // readByOthers[convId][userId] = ISO timestamp when that user last read the conv.
  readByOthers: Map<string, Map<string, string>>;
  // onlineUsers[userId] = true if that user currently has an active socket.
  onlineUsers: Map<string, boolean>;
  markConversationRead: (conversationId: string) => void;

  // Profile editing (OpenChat-tml)
  updateProfile: (fields: { name?: string; statusMessage?: string; avatarUrl?: string; discoveryMode?: 'name' | 'email_only' | 'hidden'; profileStatus?: { text?: string | null; emoji?: string | null } | null }) => Promise<void>;

  // Reconnect catch-up (OpenChat-qz0)
  // convIds that received new messages during a recent reconnect catch-up.
  // Used by the conversation list to briefly pulse those rows.
  reconnectNewConvIds: Set<string>;

  // Lifecycle
  /** explicit=false for a session that expired rather than a person signing out. */
  signOut: (options?: { explicit?: boolean }) => Promise<void>;
  bootstrapIfAuthed: () => Promise<boolean>; // returns true if a session exists
}

const Ctx = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChat must be used inside <ChatProvider>');
  return v;
}

const MATCH_STATUS_ORDER: Record<AgentMatch['status'], number> = {
  pending: 0,
  awaiting_other: 1,
  closed: 2,
  connected: 2,
};

/** Keep a later socket projection from being overwritten by a slower REST response. */
function withNewestMatch(current: Map<string, AgentMatch>, incoming: AgentMatch): Map<string, AgentMatch> {
  const existing = current.get(incoming.id);
  if (existing) {
    const existingTime = new Date(existing.updatedAt).getTime();
    const incomingTime = new Date(incoming.updatedAt).getTime();
    if (incomingTime < existingTime) return current;
    if (incomingTime === existingTime
      && MATCH_STATUS_ORDER[incoming.status] < MATCH_STATUS_ORDER[existing.status]) {
      return current;
    }
  }
  const next = new Map(current);
  next.set(incoming.id, incoming);
  return next;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  useEffect(() => { contextLaneManager.setAccount(currentUser?.userId ?? null); }, [currentUser?.userId]);
  const [isAuthed, setIsAuthed] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  // Keep the concrete socket in React state. isAuthed can render before an
  // async connect() call has installed the singleton; depending only on auth
  // made the listener effect return early and never retry on that timing.
  const [chatSocket, setChatSocket] = useState<ReturnType<typeof getSocket>>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);

  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  const [activeConversationLane, setActiveConversationLaneState] = useState<'chat' | 'context'>('chat');
  const activeConversationLaneRef = useRef<'chat' | 'context'>('chat');
  useEffect(() => {
    activeConversationLaneRef.current = activeConversationLane;
  }, [activeConversationLane]);

  const setActiveConversationLane = useCallback((lane: 'chat' | 'context') => {
    activeConversationLaneRef.current = lane;
    setActiveConversationLaneState(lane);
  }, []);

  const [visibleConversation, setVisibleConversation] = useState<{ id: string; owner: symbol } | null>(null);
  const visibilityRef = useRef<typeof visibleConversation>(null);
  const isChatVisible = useCallback((id: string) => {
    return visibilityRef.current?.id === id && activeConvIdRef.current === id
      && activeConversationLaneRef.current === 'chat';
  }, []);
  const registerConversationVisibility = useCallback((id: string) => {
    const registration = { id, owner: Symbol() };
    visibilityRef.current = registration;
    setVisibleConversation(registration);
    if (isChatVisible(id)) setUnreadByConv(current => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    return () => {
      if (visibilityRef.current?.owner !== registration.owner) return;
      visibilityRef.current = null;
      setVisibleConversation(null);
      setActiveConversationForNotifications(null);
    };
  }, [isChatVisible]);
  useEffect(() => {
    setActiveConversationForNotifications(isConnected && visibleConversation
      && isChatVisible(visibleConversation.id) ? visibleConversation.id : null);
  }, [isConnected, visibleConversation, activeConversationId, activeConversationLane, isChatVisible]);
  useEffect(() => () => setActiveConversationForNotifications(null), []);
  // Keep a ref so socket handlers (which close over a stale value) can read the
  // current active conversation without re-subscribing on every change.
  const activeConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeConvIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messageLoadGenerationRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const [messageLoadError, setMessageLoadError] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const offlineRef = useRef<OfflineChat | null>(null);
  const verifiedAccountRef = useRef<string | null>(null);
  useEffect(() => () => {
    const store = offlineRef.current;
    offlineRef.current = null;
    void store?.close();
  }, []);
  const flushingRef = useRef<{ store: OfflineChat; promise: Promise<void> } | null>(null);
  const retainedSendsRef = useRef(new Map<string, Map<string, Message>>());
  const messageAccountRef = useRef<string | null>(null);
  const sendSessionRef = useRef(0);
  const resetMessageSession = useCallback((accountId: string | null) => {
    messageAccountRef.current = accountId;
    verifiedAccountRef.current = null;
    ++sendSessionRef.current;
    retainedSendsRef.current.clear();
    visibilityRef.current = null;
    setVisibleConversation(null);
    setActiveConversationForNotifications(null);
    activeConvIdRef.current = null;
    ++messageLoadGenerationRef.current;
    historyLoadingRef.current = false;
    setActiveConversationIdState(null);
    setMessages([]);
    setLoadingMessages(false);
    setMessageLoadError(null);
    setHasMoreMessages(false);
    setLoadingOlderMessages(false);
  }, []);
  const mergeMessages = useCallback((id: string, current: Message[], incoming: Message[], history = false) => {
    const retained = retainedSendsRef.current.get(id);
    for (const message of incoming) {
      if (message.conversationId !== id || !retained?.has(message.id)) continue;
      if (history) retained.delete(message.id);
      else retained.set(message.id, message);
    }
    const retainedMessages = [...(retained?.values() ?? [])];
    const localIds = new Set(retainedMessages.map(message => message.id));
    const merged = new Map([...current.filter(message => message.conversationId === id
      && (!message.id.startsWith('local-') || localIds.has(message.id))),
    ...retainedMessages, ...incoming.filter(message => message.conversationId === id)]
      .map(message => [message.id, message]));
    return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }, []);
  const messagePatchesRef = useRef(new Map<string, (message: Message) => Message>());
  const mergeCreationMessages = useCallback((id: string, current: Message[], incoming: Message[]) => {
    const retained = retainedSendsRef.current.get(id);
    const creation = incoming.map(message => {
      const existing = current.find(item => item.id === message.id) ?? retained?.get(message.id);
      return existing?.id === message.id ? existing : message;
    });
    return mergeMessages(id, current, creation);
  }, [mergeMessages]);
  const patchMessage = useCallback((id: string, patch: (message: Message) => Message) => {
    const previous = messagePatchesRef.current.get(id);
    messagePatchesRef.current.set(id, previous ? message => patch(previous(message)) : patch);
    for (const sends of retainedSendsRef.current.values()) {
      for (const [clientId, message] of sends) {
        if (message.id === id) sends.set(clientId, patch(message));
      }
    }
    setMessages(current => current.map(message => message.id === id ? patch(message) : message));
    const store = offlineRef.current;
    if (store) for (const [conversationId, cached] of Object.entries(store.cache.threads)) {
      if (cached.some(message => message.id === id)) void store.saveMessages(conversationId,
        cached.map(message => message.id === id ? patch(message) : message)).catch(() => {});
    }
  }, []);
  const displayPending = useCallback((entry: PendingMessage, delivery = entry.state as Message['_delivery']) => {
    const id = entry.message.conversationId;
    let retained = retainedSendsRef.current.get(id);
    if (!retained) {
      retained = new Map();
      retainedSendsRef.current.set(id, retained);
    }
    // A live canonical message is stronger evidence than a lost acknowledgement.
    const existing = retained.get(entry.clientId)
      ?? offlineRef.current?.cache.threads[id]?.find(message => message.id === entry.clientId);
    if (existing && !existing.id.startsWith('local-')) retained.set(entry.clientId, existing);
    if (!existing || existing.id.startsWith('local-')) retained.set(entry.clientId, {
      ...entry.message, _delivery: delivery, _failed: delivery === 'failed',
    });
    if (activeConvIdRef.current === id) setMessages(current => mergeMessages(id, current, []));
  }, [mergeMessages]);

  const flushPending = useCallback((): Promise<void> => {
    const store = offlineRef.current;
    if (!store || !chatSocket?.connected || verifiedAccountRef.current !== store.accountId) return Promise.resolve();
    if (flushingRef.current?.store === store) return flushingRef.current.promise;
    const isCurrent = () => offlineRef.current === store;
    const run = async () => {
      // Preserve composition order. A transport failure pauses the queue until
      // reconnection or the retry timer; permanent failures do not block others.
      while (isCurrent() && chatSocket.connected && await store.isActive()) {
        const entry = [...store.pending.values()].filter(item => item.state === 'queued')
          .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))[0];
        if (!entry) return;
        const { message, clientId } = entry;
        const id = message.conversationId;
        displayPending(entry, 'sending');
        let real: Message | null = null;
        try {
          const confirmed = retainedSendsRef.current.get(id)?.get(clientId);
          if (confirmed && !confirmed.id.startsWith('local-')) real = confirmed;
          else if (message.attachments?.length) {
            const response = await api.sendMessage(id, message.content, message.attachments, clientId, message.replyToId);
            real = isDroppedMessageSend(response) ? null : response;
          } else {
            try { real = await wsSend(id, message.content, message.replyToId, clientId); }
            catch {
              if (!isCurrent() || !await store.isActive()) return;
              const response = await api.sendMessage(id, message.content, undefined, clientId, message.replyToId);
              real = isDroppedMessageSend(response) ? null : response;
            }
          }
        } catch (error) {
          if (!isCurrent() || !await store.isActive()) return;
          const observed = retainedSendsRef.current.get(id)?.get(clientId);
          if (observed && !observed.id.startsWith('local-')) real = observed;
          else {
            const status = (error as { status?: number })?.status;
            const state = retryableSendError(error) || status === 401 ? 'queued' : 'failed';
            const updated: PendingMessage = { ...entry, state };
            await store.put(updated);
            if (!isCurrent() || !await store.isActive()) return;
            displayPending(updated);
            if (state === 'queued') return;
            continue;
          }
        }
        if (!isCurrent() || !await store.isActive()) return;
        const sends = retainedSendsRef.current.get(id);
        const observed = sends?.get(clientId);
        if (!observed) { await store.remove(clientId); continue; }
        const canonical = observed && !observed.id.startsWith('local-') ? observed
          : real ? messagePatchesRef.current.get(real.id)?.(real) ?? real : null;
        if (canonical) {
          sends?.set(clientId, canonical);
          setConversations(current => applyMessageToConversationList(current, canonical).conversations);
          // Save the acknowledged message before deleting its durable outbox key.
          const history = store.cache.threads[id] ?? [];
          await store.saveMessages(id, mergeMessages(id, history, [canonical]));
        } else sends?.delete(clientId);
        if (!isCurrent() || !await store.isActive()) return;
        if (activeConvIdRef.current === id) setMessages(current => mergeCreationMessages(id,
          current.filter(item => item.id !== message.id), canonical ? [canonical] : []));
        await store.remove(clientId);
      }
    };
    const promise = run().catch(error => {
      // Disk errors keep the durable entry for a later attempt with the SAME id.
      console.warn('[ChatContext] outbox paused:', error);
      if (isCurrent()) for (const entry of store.pending.values()) displayPending(entry);
    }).finally(() => {
      if (flushingRef.current?.promise === promise) flushingRef.current = null;
    });
    flushingRef.current = { store, promise };
    return promise;
  }, [chatSocket, displayPending, mergeMessages, mergeCreationMessages]);

  useEffect(() => {
    if (!isAuthed || !isConnected) return;
    void flushPending();
    const timer = setInterval(() => { void flushPending(); }, 10000);
    return () => clearInterval(timer);
  }, [isAuthed, isConnected, flushPending]);

  useEffect(() => {
    const store = offlineRef.current;
    if (isAuthed && verifiedAccountRef.current && conversationsLoaded && store && store.accountId === currentUser?.userId) {
      void store.saveConversations(conversations).catch(error => console.warn('[ChatContext] cache unavailable:', error));
    }
  }, [conversations, conversationsLoaded, currentUser, isAuthed]);
  useEffect(() => {
    const store = offlineRef.current;
    if (isAuthed && verifiedAccountRef.current && activeConversationId && store && store.accountId === currentUser?.userId
      && !messageLoadError && (!loadingMessages || messages.length > 0)
      && messages.every(message => message.conversationId === activeConversationId)) {
      void store.saveMessages(activeConversationId, messages).catch(error => console.warn('[ChatContext] cache unavailable:', error));
    }
  }, [messages, activeConversationId, loadingMessages, messageLoadError, currentUser, isAuthed]);

  // Pagination state (OpenChat-vjc)
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  const [presence, setPresence] = useState<Map<string, { status: string; statusMessage?: string; profileStatus?: { text?: string | null; emoji?: string | null } | null }>>(new Map());
  const [typingByConv, setTypingByConv] = useState<Map<string, Set<string>>>(new Map());
  const [unreadByConv, setUnreadByConv] = useState<Map<string, number>>(new Map());
  const [matches, setMatches] = useState<Map<string, AgentMatch>>(new Map());

  const pendingMatchCount = useMemo(
    () => Array.from(matches.values()).filter(match => match.status === 'pending').length,
    [matches]
  );

  const refetchMatches = useCallback(async () => {
    try {
      const latest = await api.listMatches();
      setMatches(prev => latest.reduce(withNewestMatch, new Map(prev)));
    } catch (err) {
      console.warn('[ChatContext] refetchMatches failed:', err);
      throw err;
    }
  }, []);

  const respondToAgentMatch = useCallback(async (
    id: string,
    decision: 'approve' | 'decline'
  ): Promise<AgentMatch> => {
    const match = await api.respondToMatch(id, decision);
    // Socket delivery is best-effort. Apply the authoritative response now;
    // a later match:updated event will merge the same per-viewer projection.
    setMatches(prev => withNewestMatch(prev, match));
    return match;
  }, []);

  // Sync total unread count to the app icon badge (OpenChat-9sp).
  // setUnreadBadgeCount is a no-op on web.
  useEffect(() => {
    const total = Array.from(unreadByConv.values()).reduce((sum, n) => sum + n, 0);
    void setUnreadBadgeCount(total);
  }, [unreadByConv]);

  // AI disclosure (OpenChat-ds3)
  const [aiDisclosureAcceptedAt, setAiDisclosureAcceptedAt] = useState<string | null>(null);

  // Mute map (OpenChat-aes) — local-only; server integration deferred.
  const [mutedConvs, setMutedConvs] = useState<Record<string, string>>({});

  // Read receipts (OpenChat-0nj)
  // readByOthers[convId][userId] = ISO when that user last read the conv.
  const [readByOthers, setReadByOthers] = useState<Map<string, Map<string, string>>>(new Map());
  // onlineUsers[userId] = whether they have an active socket right now.
  const [onlineUsers, setOnlineUsers] = useState<Map<string, boolean>>(new Map());
  // Debounce ref: per-convId timer so we coalesce rapid markRead calls.
  const markReadTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Reconnect catch-up (OpenChat-qz0) ───────────────────────────────────────
  //
  // lastSyncAt: the most recent timestamp at which we were definitively in sync.
  // Updated on every message:new socket event and reconnect catch-up.
  // Initialized to the current time at bootstrap so a first-ever connect doesn't
  // try to fetch all messages since epoch.
  const lastSyncAtRef = useRef<string>(new Date().toISOString());

  // wasEverConnected: becomes true on the first 'connect' event. After that,
  // every subsequent 'connect' is a RECONNECT and should trigger catch-up.
  const wasEverConnectedRef = useRef<boolean>(false);

  // reconnectNewConvIds: conversations that received messages during the last
  // catch-up. Cleared automatically after 3 seconds (enough for a pulse animation).
  const [reconnectNewConvIds, setReconnectNewConvIds] = useState<Set<string>>(new Set());
  const missingConversationFetchesRef = useRef<Set<string>>(new Set());
  // ────────────────────────────────────────────────────────────────────────────

  const refreshConversations = useCallback(async () => {
    const session = sendSessionRef.current;
    if (!verifiedAccountRef.current || !await offlineRef.current?.isActive()) return;
    try {
      const data = await api.getConversations();
      if (session !== sendSessionRef.current || !await offlineRef.current?.isActive()) return;
      setConversations(sortConversationsByRecent(data));
      setUnreadByConv(unreadCountsFromConversations(data));
      setConversationsLoaded(true);
    } catch (err) {
      console.warn('[ChatContext] refreshConversations failed:', err);
    }
  }, []);

  const fetchMissingConversationForMessage = useCallback((msg: Message) => {
    const conversationId = msg.conversationId;
    if (missingConversationFetchesRef.current.has(conversationId)) return;
    missingConversationFetchesRef.current.add(conversationId);

    api.getConversation(conversationId)
      .then(conv => {
        setConversations(prev => {
          const nextConv = {
            ...conv,
            ...conversationLastMessage(msg),
          };
          return upsertConversation(prev, nextConv);
        });
      })
      .catch(err => console.warn('[ChatContext] fetch missing conversation failed:', err))
      .finally(() => {
        missingConversationFetchesRef.current.delete(conversationId);
      });
  }, []);

  const bootstrapIfAuthed = useCallback(async (): Promise<boolean> => {
    const token = await getToken();
    if (!token) {
      resetMessageSession(null);
      setIsAuthed(false);
      setAuthInitialized(true);
      return false;
    }
    let u = await getUser();
    if (!u?.userId) {
      // Legacy token-only sessions need one online identity lookup before any
      // account-scoped cache can be opened.
      try {
        const me = await api.getMe();
        u = { userId: me.id, email: me.email ?? '', name: me.name, avatarUrl: me.avatarUrl };
        await setSession(token, u);
      } catch {
        setAuthInitialized(true);
        return false;
      }
    }
    if (messageAccountRef.current !== u.userId) {
      void offlineRef.current?.close();
      offlineRef.current = null;
      resetMessageSession(u.userId);
      setConversations([]);
      setConversationsLoaded(false);
    }
    const session = sendSessionRef.current;
    if (!offlineRef.current) {
      const store = new OfflineChat(u.userId);
      await store.load().catch(error => console.warn('[ChatContext] offline cache unavailable:', error));
      if (session !== sendSessionRef.current || !await store.isActive()) return false;
      offlineRef.current = store;
      setConversations(store.cache.conversations);
      setUnreadByConv(unreadCountsFromConversations(store.cache.conversations));
      setConversationsLoaded(true);
      for (const entry of store.pending.values()) displayPending(entry);
    }
    setCurrentUser(u);
    setIsAuthed(true);
    setAuthInitialized(true);
    if (!isUnlinkedEmbed()) clearIdeaflowSignedOut();
    try {
      const me = await api.getMe();
      if (session !== sendSessionRef.current || !await offlineRef.current?.isActive()) return false;
      if (me.id !== u.userId) {
        const previous = offlineRef.current;
        offlineRef.current = null;
        void previous?.close();
        disconnect();
        resetMessageSession(null);
        setIsAuthed(false);
        setCurrentUser(null);
        setConversations([]);
        await clearSession();
        return false;
      }
      verifiedAccountRef.current = me.id;
      setCurrentUser({ userId: me.id, email: me.email ?? u.email ?? '',
        name: me.name, avatarUrl: me.avatarUrl, discoveryMode: me.discoveryMode ?? 'name',
        openUserDirectoryEnabled: me.openUserDirectoryEnabled === true });
      const sock = await connect();
      if (session !== sendSessionRef.current || !await offlineRef.current?.isActive()) return false;
      setChatSocket(sock);
    } catch (error) {
      console.warn('[ChatContext] identity verification or socket connect failed:', error);
      return true;
    }
    void refreshConversations();
    void refetchMatches().catch(() => {});
    lastSyncAtRef.current = new Date().toISOString();
    void api.getAiDisclosureStatus().then(ds => {
      if (session === sendSessionRef.current) setAiDisclosureAcceptedAt(ds.acceptedAt);
    }).catch(() => {});
    void loadMutedConvs().then(muted => {
      if (session === sendSessionRef.current) setMutedConvs(muted);
    });
    return true;
  }, [refreshConversations, refetchMatches, resetMessageSession, displayPending]);

  useEffect(() => {
    if (!isAuthed) return;
    let running = false;
    const resume = async () => {
      if (running) return;
      running = true;
      try {
        const store = offlineRef.current;
        if (!store) return;
        if (!await store.isActive()) {
          if (offlineRef.current !== store) return;
          offlineRef.current = null;
          void store.close();
          disconnect();
          resetMessageSession(null);
          setChatSocket(null);
          setIsConnected(false);
          setIsAuthed(false);
          setCurrentUser(null);
          setConversations([]);
          setConversationsLoaded(false);
        } else if (!verifiedAccountRef.current) {
          await bootstrapIfAuthed();
        }
      } catch (error) {
        console.warn('[ChatContext] session resumption failed:', error);
      } finally { running = false; }
    };
    const listener = () => { void resume(); };
    const timer = setInterval(listener, 10000);
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', listener);
      window.addEventListener('online', listener);
      window.addEventListener('pageshow', listener);
      window.addEventListener('focus', listener);
    }
    return () => {
      clearInterval(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', listener);
        window.removeEventListener('online', listener);
        window.removeEventListener('pageshow', listener);
        window.removeEventListener('focus', listener);
      }
    };
  }, [isAuthed, bootstrapIfAuthed, resetMessageSession]);

  // Reload history without erasing messages or edits received while REST is in flight.
  const retryMessages = useCallback(() => {
    const id = activeConvIdRef.current;
    if (!id) return;
    if (offlineRef.current && (!verifiedAccountRef.current || !chatSocket?.connected)) {
      setLoadingMessages(false);
      setMessageLoadError(offlineRef.current.cache.threads[id]?.length
        || retainedSendsRef.current.get(id)?.size ? null : 'No saved messages yet. Reconnect to load this chat.');
      return;
    }
    const generation = ++messageLoadGenerationRef.current;
    const cachedIds = new Set(messagesRef.current.map(message => message.id));
    messagePatchesRef.current.clear();
    historyLoadingRef.current = true;
    setLoadingMessages(true);
    setLoadingOlderMessages(false);
    setMessageLoadError(null);
    api.getMessages(id).then(({ messages: loaded, hasMore }) => {
      if (activeConvIdRef.current !== id || messageLoadGenerationRef.current !== generation) return;
      setMessages(current => {
        const oldest = loaded[0]?.createdAt;
        const relevant = current.filter(message => message.conversationId === id
          && (message.id.startsWith('local-')
            || (oldest !== undefined ? message.createdAt >= oldest : !cachedIds.has(message.id))));
        const merged = new Map(mergeMessages(id, relevant, loaded, true).map(message => [message.id, message]));
        for (const [messageId, message] of merged) {
          const patch = messagePatchesRef.current.get(messageId);
          if (patch) merged.set(messageId, patch(message));
        }
        return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
      setHasMoreMessages(hasMore);
    }).catch(err => {
      if (activeConvIdRef.current !== id || messageLoadGenerationRef.current !== generation) return;
      console.warn('[ChatContext] loadMessages failed:', err);
      setMessageLoadError('Could not load messages. Check your connection and try again.');
      if (err?.status === 401 || err?.status === 403 || err?.status === 404) {
        setMessages([]);
        void offlineRef.current?.forgetConversation(id).catch(() => {});
      }
    }).finally(() => {
      if (messageLoadGenerationRef.current === generation) {
        historyLoadingRef.current = false;
        setLoadingMessages(false);
      }
    });
  }, [mergeMessages, chatSocket]);

  // Wire socket listeners exactly ONCE per authed session.
  useEffect(() => {
    if (!isAuthed) return;
    const sock = chatSocket;
    if (!sock) return;

    const currentUserId = currentUser?.userId;

    const onConnect = () => {
      setIsConnected(true);
      if (!wasEverConnectedRef.current) void refreshConversations();
      // Repair failed initial loads and truncated catch-up for the open thread.
      if (activeConvIdRef.current) {
        joinConversation(activeConvIdRef.current);
        retryMessages();
      }

      if (wasEverConnectedRef.current) {
        // Match socket events are best-effort too; repair badge/card state at
        // the same reconnect boundary used for missed chat messages.
        void refetchMatches().catch(() => { /* already logged by refetchMatches */ });
        // This is a RECONNECT. Fetch missed messages.
        const since = lastSyncAtRef.current;
        console.log('[ChatContext] reconnect — fetching messages since', since);
        api.messagesSince(since).then(({ messages: missed, truncated }) => {
          if (truncated) {
            // Too many messages to merge; fall back to a full refresh.
            console.warn('[ChatContext] reconnect catch-up truncated — doing full refresh');
            void refreshConversations();
            return;
          }
          if (missed.length === 0) return;
          for (const message of missed) mergeCreationMessages(message.conversationId, [], [message]);

          const newConvIds = new Set<string>();

          // Merge messages into the active conversation's list (deduplicated).
          const activeId = activeConvIdRef.current;
          if (activeId) {
            const forActive = missed.filter(m => m.conversationId === activeId);
            if (forActive.length > 0) {
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id));
                const fresh = forActive.filter(m => !existingIds.has(m.id)
                  && (!prev[0] || m.createdAt >= prev[0].createdAt))
                  .map(m => messagePatchesRef.current.get(m.id)?.(m) ?? m);
                return mergeCreationMessages(activeId, prev, fresh);
              });
            }
          }

          // Update conversation list previews and unread counters.
          setConversations(prev => {
            let next = [...prev];
            for (const msg of missed) {
              const idx = next.findIndex(c => c.id === msg.conversationId);
              if (idx >= 0) {
                const updated = {
                  ...next[idx],
                  ...conversationLastMessage(msg),
                };
                next[idx] = updated;
                newConvIds.add(msg.conversationId);
              } else {
                fetchMissingConversationForMessage(msg);
                newConvIds.add(msg.conversationId);
              }
            }
            return sortConversationsByRecent(next);
          });

          // Context and blurred screens must retain Chat unread counts even
          // when their conversation remains selected.
          setUnreadByConv(prev => {
            const next = new Map(prev);
            for (const msg of missed) {
              if (!isChatVisible(msg.conversationId) && msg.senderId !== currentUserId) {
                next.set(msg.conversationId, (next.get(msg.conversationId) ?? 0) + 1);
              }
            }
            return next;
          });

          // Pulse the affected conversation rows for ~3s.
          if (newConvIds.size > 0) {
            setReconnectNewConvIds(newConvIds);
            setTimeout(() => setReconnectNewConvIds(new Set()), 3000);
          }

          // Advance the sync cursor.
          const latest = missed[missed.length - 1].createdAt;
          if (latest) lastSyncAtRef.current = latest;
        }).catch(err => {
          console.warn('[ChatContext] reconnect messagesSince failed:', err);
          // On error, fall back to a full conversation refresh so we're not stale.
          void refreshConversations();
        });
      }

      wasEverConnectedRef.current = true;
    };

    const onDisconnect = () => {
      setIsConnected(false);
      // Record the disconnect time as the start of the gap window.
      lastSyncAtRef.current = new Date().toISOString();
    };

    const onMessage = (msg: Message) => {
      const store = offlineRef.current;
      if (store) void store.saveMessages(msg.conversationId,
        mergeCreationMessages(msg.conversationId, store.cache.threads[msg.conversationId] ?? [], [msg])).catch(() => {});
      // If this is the active conversation, append to message list.
      mergeCreationMessages(msg.conversationId, [], [msg]);
      if (msg.conversationId === activeConvIdRef.current) {
        setMessages(prev => mergeCreationMessages(msg.conversationId, prev,
          [messagePatchesRef.current.get(msg.id)?.(msg) ?? msg]));
      }
      // Update conversation row preview + re-sort.
      setConversations(prev => {
        const { conversations: next, found } = applyMessageToConversationList(prev, msg);
        if (!found) {
          fetchMissingConversationForMessage(msg);
        }
        return next;
      });
      // A selected conversation only suppresses unread/banner updates while
      // its Chat lane is visible. The banner also filters muted conversations.
      if (!isChatVisible(msg.conversationId) && msg.senderId !== currentUser?.userId) {
        setUnreadByConv(prev => {
          const next = new Map(prev);
          next.set(msg.conversationId, (next.get(msg.conversationId) ?? 0) + 1);
          return next;
        });
        // Slide-down banner with sender + preview. Matches iMessage/WhatsApp
        // pattern when the user is in app but on a different chat. Best-
        // effort lookup of sender display name from local state.
        try {
          const senderName = msg.sender?.name
            || msg.sender?.email?.split('@')[0]
            || 'Someone';
          const preview = msg.content?.slice(0, 140) || '';
          showInAppBanner({
            conversationId: msg.conversationId,
            senderName,
            senderEmail: msg.sender?.email,
            preview,
          });
        } catch { /* swallow — banner is a nice-to-have */ }
      }
      // Advance the sync cursor so we don't re-fetch this message on next reconnect.
      if (msg.createdAt && msg.createdAt > lastSyncAtRef.current) {
        lastSyncAtRef.current = msg.createdAt;
      }
    };

    const onConversationCreated = (e: ConversationEvent) => {
      const conv = e.conversation;
      if (!conv?.id) return;
      setConversations(prev => upsertConversation(prev, conv));
    };

    const onConversationUpdated = (e: ConversationEvent) => {
      const conv = e.conversation;
      if (!conv?.id) return;
      setConversations(prev => prev.map(c => (c.id === conv.id ? { ...c, ...conv } : c)));
    };

    const onParticipantAdded = (e: ParticipantEvent) => {
      if (e.conversation) onConversationCreated({ conversationId: e.conversationId, conversation: e.conversation });
    };

    const onParticipantRemoved = (e: ParticipantEvent) => {
      // If WE were removed, drop the conv.
      if (e.userId === currentUser?.userId) {
        void offlineRef.current?.forgetConversation(e.conversationId).catch(() => {});
        setConversations(prev => prev.filter(c => c.id !== e.conversationId));
        if (activeConvIdRef.current === e.conversationId) {
          setActiveConversationIdState(null);
        }
      } else if (e.conversation) {
        onConversationUpdated({ conversationId: e.conversationId, conversation: e.conversation });
      }
    };

    const onTypingStart = (e: TypingEvent) => {
      setTypingByConv(prev => {
        const next = new Map(prev);
        const set = new Set(next.get(e.conversationId) ?? []);
        set.add(e.userId);
        next.set(e.conversationId, set);
        return next;
      });
    };

    const onTypingStop = (e: TypingEvent) => {
      setTypingByConv(prev => {
        const next = new Map(prev);
        const set = new Set(next.get(e.conversationId) ?? []);
        set.delete(e.userId);
        if (set.size === 0) next.delete(e.conversationId);
        else next.set(e.conversationId, set);
        return next;
      });
    };

    const onPresence = (e: PresenceEvent) => {
      setPresence(prev => {
        const next = new Map(prev);
        next.set(e.userId, { status: e.status, statusMessage: e.statusMessage });
        return next;
      });
    };

    const onMatchUpdated = ({ match }: MatchEvent) => {
      if (!match?.id) return;
      // `match` is already the server's per-viewer projection. Store it as-is;
      // never combine it with conversation participants or other identity data.
      setMatches(prev => withNewestMatch(prev, match));
    };

    // read:updated — another participant marked the conversation read (OpenChat-0nj)
    const onReadUpdated = (e: {
      conversationId: string;
      userId: string;
      lastReadAt: string;
      readMap?: Record<string, string | null>;
      onlineMap?: Record<string, boolean>;
    }) => {
      setReadByOthers(prev => {
        const next = new Map(prev);
        const convMap = new Map(prev.get(e.conversationId) ?? []);
        convMap.set(e.userId, e.lastReadAt);
        // If the server sent the full map, seed it in one pass.
        if (e.readMap) {
          for (const [uid, ts] of Object.entries(e.readMap)) {
            if (ts) convMap.set(uid, ts);
          }
        }
        next.set(e.conversationId, convMap);
        return next;
      });
      if (e.onlineMap) {
        setOnlineUsers(prev => {
          const next = new Map(prev);
          for (const [uid, online] of Object.entries(e.onlineMap!)) {
            next.set(uid, online);
          }
          return next;
        });
      }
    };

    // user:profile-updated — someone in a shared conv updated their name/status (OpenChat-tml)
    const onProfileUpdated = (e: { userId: string; name?: string; statusMessage?: string; profileStatus?: { text?: string | null; emoji?: string | null } | null }) => {
      // Update participant info in every conversation that has this user.
      setConversations(prev => prev.map(conv => {
        if (!conv.participants?.some(p => p?.user?.id === e.userId)) return conv;
        return {
          ...conv,
          participants: conv.participants.map(p =>
            p?.user?.id === e.userId
              ? { ...p, user: { ...p.user, name: e.name ?? p.user.name, statusMessage: e.statusMessage ?? p.user.statusMessage, profileStatus: e.profileStatus !== undefined ? e.profileStatus : p.user.profileStatus } }
              : p
          ),
        };
      }));
    };

    // message:updated — edit or soft-delete (OpenChat-q9h)
    const onMessageUpdated = (msg: Message) => {
      if (msg.conversationId === activeConvIdRef.current) {
        patchMessage(msg.id, message => ({
          ...message, content: msg.content,
          ...(msg.editedAt !== undefined ? { editedAt: msg.editedAt } : {}),
          ...(msg.deletedAt !== undefined ? { deletedAt: msg.deletedAt, attachments: msg.attachments } : {}),
        }));
      }
    };

    // message:reactions-updated — reaction add/remove (OpenChat-7bd)
    const onReactionsUpdated = (payload: { messageId: string; conversationId: string; reactions: ReactionSummary[] }) => {
      if (payload.conversationId === activeConvIdRef.current) {
        patchMessage(payload.messageId, message => ({ ...message, reactions: payload.reactions }));
      }
    };

    // message:preview-ready — link preview fetched server-side (OpenChat-hq2)
    const onPreviewReady = (payload: { messageId: string; preview: LinkPreview }) => {
      patchMessage(payload.messageId, m => {
        const existing = m.linkPreviews ?? [];
        // Deduplicate by URL
        if (existing.some(p => p.url === payload.preview.url)) return m;
        return { ...m, linkPreviews: [...existing, payload.preview] };
      });
    };

    // message:transcript — server-side voice transcription ready (OpenChat-4jn).
    // Sets the matching message's transcript so the caption appears live under
    // the voice bubble. `messages` only holds the active conversation, so the
    // conversation guard keeps stale-conversation events from no-op churning.
    const onTranscript = (payload: { messageId: string; conversationId: string; transcript: string }) => {
      if (payload.conversationId !== activeConvIdRef.current) return;
      patchMessage(payload.messageId, message => ({ ...message, transcript: payload.transcript }));
    };

    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    sock.on('message:new', onMessage);
    sock.on('message:updated', onMessageUpdated);
    sock.on('message:reactions-updated', onReactionsUpdated);
    sock.on('message:preview-ready', onPreviewReady);
    sock.on('message:transcript', onTranscript);
    sock.on('conversation:created', onConversationCreated);
    sock.on('conversation:updated', onConversationUpdated);
    sock.on('participant:added', onParticipantAdded);
    sock.on('participant:removed', onParticipantRemoved);
    sock.on('typing:start', onTypingStart);
    sock.on('typing:stop', onTypingStop);
    sock.on('presence:updated', onPresence);
    sock.on('match:updated', onMatchUpdated);
    sock.on('read:updated', onReadUpdated);
    sock.on('user:profile-updated', onProfileUpdated);

    setIsConnected(sock.connected);

    return () => {
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.off('message:new', onMessage);
      sock.off('message:updated', onMessageUpdated);
      sock.off('message:reactions-updated', onReactionsUpdated);
      sock.off('message:preview-ready', onPreviewReady);
      sock.off('message:transcript', onTranscript);
      sock.off('conversation:created', onConversationCreated);
      sock.off('conversation:updated', onConversationUpdated);
      sock.off('participant:added', onParticipantAdded);
      sock.off('participant:removed', onParticipantRemoved);
      sock.off('typing:start', onTypingStart);
      sock.off('typing:stop', onTypingStop);
      sock.off('presence:updated', onPresence);
      sock.off('match:updated', onMatchUpdated);
      sock.off('read:updated', onReadUpdated);
      sock.off('user:profile-updated', onProfileUpdated);
    };
  }, [isAuthed, chatSocket, currentUser?.userId, refreshConversations, fetchMissingConversationForMessage, refetchMatches, retryMessages, patchMessage, mergeCreationMessages, isChatVisible]);

  // setActiveConversation: clears unread, joins/leaves rooms, loads messages.
  const setActiveConversation = useCallback((id: string | null, opts?: { lane?: 'chat' | 'context' }) => {
    // A late response must not finish a newer load, including A → back → A.
    ++messageLoadGenerationRef.current;
    setMessageLoadError(null);
    const prev = activeConvIdRef.current;
    if (prev && prev !== id) leaveConversation(prev);

    const nextLane = opts?.lane || 'chat';
    activeConvIdRef.current = id;
    setActiveConversationIdState(id);
    setActiveConversationLane(nextLane);
    activeConversationLaneRef.current = nextLane;

    if (id) {
      if (verifiedAccountRef.current) joinConversation(id);
      if (isChatVisible(id)) {
        setUnreadByConv(curr => {
          if (!curr.has(id)) return curr;
          const next = new Map(curr);
          next.delete(id);
          return next;
        });
      }
      if (prev !== id) {
        messagePatchesRef.current.clear();
        setMessages(mergeMessages(id, offlineRef.current?.cache.threads[id] ?? [], []));
      }
      setHasMoreMessages(false);
      setLoadingOlderMessages(false);
      retryMessages();
    } else {
      setMessages([]);
      historyLoadingRef.current = false;
      setLoadingMessages(false);
      setHasMoreMessages(false);
    }
  }, [retryMessages, mergeMessages, isChatVisible]);

  // Load older messages for the active conversation (OpenChat-vjc).
  // Uses the createdAt of the earliest currently-loaded message as the cursor.
  // Prepends results to the message list; deduplicates by id in case of overlap.
  const loadOlderMessages = useCallback(async (conversationId: string) => {
    if (historyLoadingRef.current || loadingOlderMessages || !hasMoreMessages) return;
    // Find the oldest message currently in state (messages are sorted oldest→newest).
    const oldest = messages.find(message => !message.id.startsWith('local-')
      && !retainedSendsRef.current.get(conversationId)?.has(message.id));
    if (!oldest) return;
    const generation = messageLoadGenerationRef.current;
    setLoadingOlderMessages(true);
    try {
      const { messages: older, hasMore } = await api.getMessagesBefore(conversationId, oldest.createdAt);
      if (activeConvIdRef.current === conversationId && generation === messageLoadGenerationRef.current) {
        setMessages(prev => {
          const patched = older.map(message => messagePatchesRef.current.get(message.id)?.(message) ?? message);
          return mergeMessages(conversationId, prev, patched, true);
        });
        setHasMoreMessages(hasMore);
      }
    } catch (err) {
      console.warn('[ChatContext] loadOlderMessages failed:', err);
    } finally {
      if (generation === messageLoadGenerationRef.current) setLoadingOlderMessages(false);
    }
  }, [loadingOlderMessages, hasMoreMessages, messages, mergeMessages]);

  // Optimistic send: append a local message immediately, then replace with
  // server canonical on success. Accepts optional replyToId for threaded replies
  // (OpenChat-uxj). Server support is a follow-up; the field is passed through
  // in the socket payload so it round-trips once the server handles it.
  // Target-aware core used by the global voice recorder (build-90 pieces 1+2).
  // The public sendMessage wrapper below preserves the existing active-chat
  // API, while a recording can still return to the conversation where it began.
  const sendMessageToConversation = useCallback(async (
    id: string,
    content: string,
    replyToId?: string,
    attachments?: Attachment[]
  ) => {
    const hasText = !!content.trim();
    const hasAttachments = !!attachments?.length;
    if (!id || (!hasText && !hasAttachments)) return;

    const store = offlineRef.current;
    if (!store || !currentUser || store.accountId !== currentUser.userId) throw new Error('Sign in before sending');
    const clientId = randomUUID();
    const entry: PendingMessage = { clientId, state: 'queued', message: {
      id: `local-${clientId}`, content, conversationId: id,
      senderId: currentUser.userId, createdAt: new Date().toISOString(),
      sender: { id: currentUser.userId, email: currentUser.email, name: currentUser.name, avatarUrl: currentUser.avatarUrl },
      replyToId, attachments,
    } };
    await store.put(entry);
    if (offlineRef.current !== store) return;
    displayPending(entry);
    setConversations(current => applyMessageToConversationList(current, entry.message).conversations);
    await flushPending();
  }, [currentUser, displayPending, flushPending]);

  const retryPendingMessage = useCallback(async (clientId: string) => {
    const store = offlineRef.current;
    const entry = store?.pending.get(clientId);
    if (!store || !entry) return;
    const queued: PendingMessage = { ...entry, state: 'queued' };
    await store.put(queued);
    if (offlineRef.current !== store) return;
    displayPending(queued);
    await flushPending();
  }, [displayPending, flushPending]);

  const discardPendingMessage = useCallback(async (clientId: string) => {
    const store = offlineRef.current;
    const entry = store?.pending.get(clientId);
    // A send may already have reached the server. Only failed entries can be
    // removed here; queued entries must keep their idempotency key.
    if (!store || !entry || entry.state !== 'failed') return;
    await store.remove(clientId);
    if (offlineRef.current !== store) return;
    retainedSendsRef.current.get(entry.message.conversationId)?.delete(clientId);
    setMessages(current => current.filter(message => message.id !== entry.message.id));
  }, []);

  const sendMessage = useCallback(async (
    content: string,
    replyToId?: string,
    attachments?: Attachment[]
  ) => {
    const id = activeConvIdRef.current;
    if (!id) return;
    await sendMessageToConversation(id, content, replyToId, attachments);
  }, [sendMessageToConversation]);

  const createConversation = useCallback(async (
    participantIds: string[],
    opts?: { title?: string; type?: 'direct' | 'group' }
  ) => {
    const type: 'direct' | 'group' = opts?.type ?? (participantIds.length > 1 ? 'group' : 'direct');
    const conv = await api.createConversation(participantIds, opts?.title, type);
    setConversations(prev => upsertConversation(prev, conv));
    return conv;
  }, []);

  const renameConversation = useCallback(async (conversationId: string, title: string) => {
    const updated = await api.renameConversation(conversationId, title);
    setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, ...updated } : c));
  }, []);

  const addParticipant = useCallback(async (conversationId: string, userId: string) => {
    const updated = await api.addParticipant(conversationId, userId);
    setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, ...updated } : c));
  }, []);

  const removeParticipant = useCallback(async (conversationId: string, userId: string) => {
    await api.removeParticipant(conversationId, userId);
    // Server will emit participant:removed; the listener handles the local update.
    // For "leave a group" (self-remove), drop the conv eagerly so UI updates fast.
    if (userId === currentUser?.userId) {
      setConversations(prev => prev.filter(c => c.id !== conversationId));
      if (activeConvIdRef.current === conversationId) setActiveConversation(null);
    } else {
      try {
        const fresh = await api.getConversation(conversationId);
        setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, ...fresh } : c));
      } catch {
        /* socket event will eventually catch up */
      }
    }
  }, [currentUser?.userId, setActiveConversation]);

  const reportTyping = useCallback((conversationId: string, isTyping: boolean) => {
    if (isTyping) emitTypingStart(conversationId);
    else emitTypingStop(conversationId);
  }, []);

  // Edit own message (OpenChat-q9h). Calls PATCH; server emits message:updated
  // which the socket handler picks up and updates local state.
  const editMessage = useCallback(async (messageId: string, content: string) => {
    const updated = await api.editMessage(messageId, content);
    // Optimistic local update (socket event will also arrive for other clients).
    if (updated.conversationId !== activeConvIdRef.current) return;
    patchMessage(messageId, message => ({ ...message, content: updated.content,
      ...(updated.editedAt !== undefined ? { editedAt: updated.editedAt } : {}),
      ...(updated.deletedAt !== undefined ? { deletedAt: updated.deletedAt, attachments: updated.attachments } : {}),
    }));
  }, [patchMessage]);

  // Soft-delete own message (OpenChat-q9h). Calls DELETE; server emits message:updated.
  const deleteMessage = useCallback(async (messageId: string) => {
    const updated = await api.deleteMessage(messageId);
    if (updated.conversationId !== activeConvIdRef.current) return;
    patchMessage(messageId, message => ({ ...message, content: updated.content,
      ...(updated.editedAt !== undefined ? { editedAt: updated.editedAt } : {}),
      ...(updated.deletedAt !== undefined ? { deletedAt: updated.deletedAt, attachments: updated.attachments } : {}),
    }));
  }, [patchMessage]);

  // Toggle reaction (OpenChat-7bd). Adds if not present, removes if byMe already.
  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    // Find current state of this reaction for the current user.
    const msg = messages.find(m => m.id === messageId);
    const existing = msg?.reactions?.find(r => r.emoji === emoji);
    let result: { reactions: ReactionSummary[] };
    if (existing?.byMe) {
      result = await api.removeReaction(messageId, emoji);
    } else {
      result = await api.addReaction(messageId, emoji);
    }
    if (msg?.conversationId !== activeConvIdRef.current) return;
    patchMessage(messageId, message => ({ ...message, reactions: result.reactions }));
  }, [messages, patchMessage]);

  // Block user (OpenChat-46p). Calls API, then removes the DM conversation
  // with that user from the local list so the UI updates immediately.
  const blockUser = useCallback(async (userId: string) => {
    await api.blockUser(userId);
    // Remove any direct conversation with the blocked user from the list.
    setConversations(prev => prev.filter(conv => {
      if (conv.type !== 'direct') return true;
      return !conv.participants?.some(p => p?.user?.id === userId);
    }));
  }, []);

  const acceptAiDisclosure = useCallback(async () => {
    try {
      const res = await api.acceptAiDisclosure();
      setAiDisclosureAcceptedAt(res.acceptedAt);
    } catch (err) {
      console.warn('[ChatContext] acceptAiDisclosure failed:', err);
    }
  }, []);

  // Mute / unmute a conversation (OpenChat-aes). Now multi-device synced:
  // we optimistically update local state + AsyncStorage, then fire the
  // server PATCH to set rel.mutedUntil on the PARTICIPATES_IN edge so
  // other devices pick it up on next /conversations refresh AND the
  // server-side push fanout filters muted recipients.
  const muteConv = useCallback(async (convId: string, until: Date | 'always' | null) => {
    // Optimistic local update — keep the AsyncStorage path for offline use
    // and immediate UI response.
    await muteConvStorage(convId, until);
    setMutedConvs(prev => {
      const next = { ...prev };
      if (until === null) {
        delete next[convId];
      } else if (until === 'always') {
        next[convId] = 'always';
      } else {
        next[convId] = until.toISOString();
      }
      return next;
    });
    // Fire-and-forget server sync. Failure leaves local state correct;
    // a future /conversations refresh will reconcile.
    try {
      await api.setConversationMute(convId, until);
    } catch (err) {
      console.warn('[mute] server sync failed (local state preserved):', err);
    }
  }, []);

  // Mark conversation as read (OpenChat-0nj).
  // Debounced 500ms so we don't hammer the server on every incoming message
  // while the user is actively in the conversation.
  const markConversationRead = useCallback((conversationId: string) => {
    if (!isChatVisible(conversationId)) return;
    const timers = markReadTimers.current;
    const existing = timers.get(conversationId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(conversationId);
      if (!isChatVisible(conversationId)) return;
      api.markRead(conversationId)
        .then(res => {
          // Seed readByOthers from the response's readMap.
          setReadByOthers(prev => {
            const next = new Map(prev);
            const convMap = new Map(prev.get(conversationId) ?? []);
            for (const [uid, ts] of Object.entries(res.readMap)) {
              if (ts) convMap.set(uid, ts);
            }
            next.set(conversationId, convMap);
            return next;
          });
          setOnlineUsers(prev => {
            const next = new Map(prev);
            for (const [uid, online] of Object.entries(res.onlineMap)) {
              next.set(uid, online);
            }
            return next;
          });
          // Also clear the unread badge for this conversation.
          if (!isChatVisible(conversationId)) return;
          setUnreadByConv(curr => {
            if (!curr.has(conversationId)) return curr;
            const next = new Map(curr);
            next.delete(conversationId);
            return next;
          });
        })
        .catch(err => console.warn('[ChatContext] markRead failed:', err));
    }, 500);
    timers.set(conversationId, t);
  }, [isChatVisible]);

  // Update own profile (OpenChat-tml).
  const updateProfile = useCallback(async (fields: { name?: string; statusMessage?: string; avatarUrl?: string; discoveryMode?: 'name' | 'email_only' | 'hidden'; profileStatus?: { text?: string | null; emoji?: string | null } | null }) => {
    const updated = await api.updateProfile(fields);
    // Optimistically patch currentUser in memory so the UI sees the change immediately.
    setCurrentUser(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        name: updated.name ?? prev.name,
        avatarUrl: updated.avatarUrl ?? prev.avatarUrl,
        discoveryMode: updated.discoveryMode ?? prev.discoveryMode,
      };
    });
    // Also update the user's own participant entry in conversations.
    if (currentUser) {
      setConversations(prev => prev.map(conv => {
        if (!conv.participants?.some(p => p?.user?.id === currentUser.userId)) return conv;
        return {
          ...conv,
          participants: conv.participants.map(p =>
            p?.user?.id === currentUser.userId
              ? { ...p, user: { ...p.user, name: updated.name ?? p.user.name, statusMessage: updated.statusMessage ?? p.user.statusMessage, avatarUrl: updated.avatarUrl ?? p.user.avatarUrl, discoveryMode: updated.discoveryMode ?? p.user.discoveryMode, profileStatus: updated.profileStatus !== undefined ? updated.profileStatus : p.user.profileStatus } }
              : p
          ),
        };
      }));
    }
  }, [currentUser]);

  const signOut = useCallback(async ({ explicit = true }: { explicit?: boolean } = {}) => {
    // The next Ideaflow sign-in asks which account (prompt=select_account)
    // instead of silently reusing the provider session (web: localStorage,
    // native: AsyncStorage; each call is a no-op on the other platform).
    if (explicit && !isUnlinkedEmbed()) {
      markIdeaflowAccountChoice();
      void markIdeaflowAccountChoiceNative();
      // Web: never sign this browser back in automatically (code-xbh.21.1; no-op on native).
      markIdeaflowSignedOut();
    }
    try { emitPresenceUpdate('offline'); } catch { /* best effort */ }
    disconnect();
    const offline = offlineRef.current;
    offlineRef.current = null;
    const cleanup = offline?.close(explicit);
    setIsConnected(false);
    resetMessageSession(null);
    activeConvIdRef.current = null;
    ++messageLoadGenerationRef.current;
    historyLoadingRef.current = false;
    setLoadingMessages(false);
    setMessageLoadError(null);
    contextLaneManager.setAccount(null);
    await cleanup?.catch(error => console.warn('[ChatContext] cache cleanup failed:', error));
    await clearSession();
    setIsAuthed(false);
    setCurrentUser(null);
    setChatSocket(null);
    setConversations([]);
    setConversationsLoaded(false);
    setMessages([]);
    setHasMoreMessages(false);
    setLoadingOlderMessages(false);
    setActiveConversationIdState(null);
    setPresence(new Map());
    setTypingByConv(new Map());
    setUnreadByConv(new Map());
    setMatches(new Map());
    setAiDisclosureAcceptedAt(null);
    setReadByOthers(new Map());
    setOnlineUsers(new Map());
    setReconnectNewConvIds(new Set());
    wasEverConnectedRef.current = false;
    lastSyncAtRef.current = new Date().toISOString();
  }, [resetMessageSession]);

  // 401/403 cascade. Any API call that gets back a token-expired response
  // flips us to Login. Listener is global because requests can fire from
  // anywhere — context handler, screen-level fallbacks, etc.
  useEffect(() => {
    const off = onAuthExpired(() => { void signOut({ explicit: false }); });
    return off;
  }, [signOut]);

  const value = useMemo<ChatContextValue>(() => ({
    currentUser, isAuthed, authInitialized, isConnected,
    conversations, conversationsLoaded, refreshConversations,
    createConversation, renameConversation, addParticipant, removeParticipant,
    activeConversationId, activeConversationLane, setActiveConversationLane, isChatVisible, registerConversationVisibility, setActiveConversation, messages, loadingMessages, messageLoadError, retryMessages,
    loadOlderMessages, hasMoreMessages, loadingOlderMessages,
    sendMessage, sendMessageToConversation, retryPendingMessage, discardPendingMessage,
    editMessage, deleteMessage,
    toggleReaction,
    blockUser,
    presence, typingByConv, reportTyping, unreadByConv,
    matches, pendingMatchCount, refetchMatches, respondToAgentMatch,
    aiDisclosureAcceptedAt, acceptAiDisclosure,
    mutedConvs, muteConv,
    readByOthers, onlineUsers, markConversationRead,
    updateProfile,
    reconnectNewConvIds,
    signOut, bootstrapIfAuthed,
  }), [
    currentUser, isAuthed, authInitialized, isConnected,
    conversations, conversationsLoaded, refreshConversations,
    createConversation, renameConversation, addParticipant, removeParticipant,
    activeConversationId, activeConversationLane, setActiveConversationLane, isChatVisible, registerConversationVisibility, setActiveConversation, messages, loadingMessages, messageLoadError, retryMessages,
    loadOlderMessages, hasMoreMessages, loadingOlderMessages,
    sendMessage, sendMessageToConversation, retryPendingMessage, discardPendingMessage,
    editMessage, deleteMessage,
    toggleReaction,
    blockUser,
    presence, typingByConv, reportTyping, unreadByConv,
    matches, pendingMatchCount, refetchMatches, respondToAgentMatch,
    aiDisclosureAcceptedAt, acceptAiDisclosure,
    mutedConvs, muteConv,
    readByOthers, onlineUsers, markConversationRead,
    updateProfile,
    reconnectNewConvIds,
    signOut, bootstrapIfAuthed, visibleConversation,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Avoid `Status` lint complaint when unused upstream.
export type { Status };
