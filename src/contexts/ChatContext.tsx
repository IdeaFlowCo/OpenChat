/**
 * ChatContext — the single source of truth for socket lifecycle, conversations,
 * presence, typing, and unread counts in the mobile app.
 *
 * Mirrors the web ChatContext at flinch-sequel/client/src/contexts/ChatContext.tsx
 * but trimmed for mobile + no DOM. The screens consume `useChat()` for state
 * and actions; they shouldn't subscribe to socket events directly.
 *
 * Reconnect catch-up (OpenChat-qz0): on socket reconnect (not first connect),
 * we call GET /api/chat/messages/since to fetch messages missed during the
 * disconnect window and merge them into local state.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import {
  setUnreadBadgeCount,
  loadMutedConvs,
  muteConversation as muteConvStorage,
} from '../services/notifications';
import {
  api,
  Attachment,
  Conversation,
  CurrentUser,
  Message,
  ReactionSummary,
  User,
  getUser,
  getToken,
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
} from '../api/socket';

type Status = 'available' | 'away' | 'busy' | 'invisible';

interface ChatContextValue {
  // Identity / session
  currentUser: CurrentUser | null;
  isAuthed: boolean;
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
  setActiveConversation: (id: string | null) => void;
  messages: Message[]; // for the active conversation
  loadingMessages: boolean;
  loadOlderMessages: (conversationId: string) => Promise<void>;
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  sendMessage: (content: string, replyToId?: string, attachments?: Attachment[]) => Promise<void>;

  // Edit / delete messages (OpenChat-q9h)
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;

  // Reactions (OpenChat-7bd)
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;

  // Block (OpenChat-46p)
  blockUser: (userId: string) => Promise<void>;

  // Presence & typing
  presence: Map<string, { status: string; statusMessage?: string }>;
  typingByConv: Map<string, Set<string>>;
  reportTyping: (conversationId: string, isTyping: boolean) => void;

  // Unread counters
  unreadByConv: Map<string, number>;

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
  updateProfile: (fields: { name?: string; statusMessage?: string }) => Promise<void>;

  // Reconnect catch-up (OpenChat-qz0)
  // convIds that received new messages during a recent reconnect catch-up.
  // Used by the conversation list to briefly pulse those rows.
  reconnectNewConvIds: Set<string>;

  // Lifecycle
  signOut: () => Promise<void>;
  bootstrapIfAuthed: () => Promise<boolean>; // returns true if a session exists
}

const Ctx = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChat must be used inside <ChatProvider>');
  return v;
}

function sortByRecent(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    const aT = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bT = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bT - aT;
  });
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isAuthed, setIsAuthed] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);

  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  // Keep a ref so socket handlers (which close over a stale value) can read the
  // current active conversation without re-subscribing on every change.
  const activeConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeConvIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // Pagination state (OpenChat-vjc)
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  const [presence, setPresence] = useState<Map<string, { status: string; statusMessage?: string }>>(new Map());
  const [typingByConv, setTypingByConv] = useState<Map<string, Set<string>>>(new Map());
  const [unreadByConv, setUnreadByConv] = useState<Map<string, number>>(new Map());

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
  // Updated on every message:new socket event AND on initial conversation load.
  // Initialized to the current time at bootstrap so a first-ever connect doesn't
  // try to fetch all messages since epoch.
  const lastSyncAtRef = useRef<string>(new Date().toISOString());

  // wasEverConnected: becomes true on the first 'connect' event. After that,
  // every subsequent 'connect' is a RECONNECT and should trigger catch-up.
  const wasEverConnectedRef = useRef<boolean>(false);

  // reconnectNewConvIds: conversations that received messages during the last
  // catch-up. Cleared automatically after 3 seconds (enough for a pulse animation).
  const [reconnectNewConvIds, setReconnectNewConvIds] = useState<Set<string>>(new Set());
  // ────────────────────────────────────────────────────────────────────────────

  const refreshConversations = useCallback(async () => {
    try {
      const data = await api.getConversations();
      setConversations(sortByRecent(data));
      setConversationsLoaded(true);
    } catch (err) {
      console.warn('[ChatContext] refreshConversations failed:', err);
    }
  }, []);

  const bootstrapIfAuthed = useCallback(async (): Promise<boolean> => {
    const token = await getToken();
    if (!token) {
      setIsAuthed(false);
      return false;
    }
    const u = await getUser();
    setCurrentUser(u);
    setIsAuthed(true);
    try {
      await connect();
    } catch (e) {
      console.warn('[ChatContext] socket connect failed during bootstrap:', e);
    }
    await refreshConversations();
    // Seed lastSyncAt from now so that on reconnect we only fetch messages
    // that arrived after this bootstrap, not everything since epoch.
    lastSyncAtRef.current = new Date().toISOString();
    // Fetch AI disclosure status (OpenChat-ds3). Non-fatal if it fails.
    try {
      const ds = await api.getAiDisclosureStatus();
      setAiDisclosureAcceptedAt(ds.acceptedAt);
    } catch {
      /* non-fatal — banner will show until server is updated */
    }
    // Load mute map from AsyncStorage (OpenChat-aes). Non-fatal.
    const muted = await loadMutedConvs();
    setMutedConvs(muted);
    return true;
  }, [refreshConversations]);

  // Wire socket listeners exactly ONCE per authed session.
  useEffect(() => {
    if (!isAuthed) return;
    const sock = getSocket();
    if (!sock) return;

    const currentUserId = currentUser?.userId;

    const onConnect = () => {
      setIsConnected(true);

      if (wasEverConnectedRef.current) {
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

          const newConvIds = new Set<string>();

          // Merge messages into the active conversation's list (deduplicated).
          const activeId = activeConvIdRef.current;
          if (activeId) {
            const forActive = missed.filter(m => m.conversationId === activeId);
            if (forActive.length > 0) {
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id));
                const fresh = forActive.filter(m => !existingIds.has(m.id));
                if (fresh.length === 0) return prev;
                // Insert in chronological order: prev is oldest→newest already.
                return [...prev, ...fresh].sort((a, b) =>
                  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                );
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
                  lastMessagePreview: msg.content.slice(0, 100),
                  lastMessageAt: msg.createdAt,
                };
                next[idx] = updated;
                newConvIds.add(msg.conversationId);
              }
            }
            return sortByRecent(next);
          });

          // Bump unread counters for non-active conversations where someone
          // else sent messages.
          const activeId2 = activeConvIdRef.current;
          setUnreadByConv(prev => {
            const next = new Map(prev);
            for (const msg of missed) {
              if (msg.conversationId !== activeId2 && msg.senderId !== currentUserId) {
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
      // If this is the active conversation, append to message list.
      if (msg.conversationId === activeConvIdRef.current) {
        setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
      }
      // Update conversation row preview + re-sort.
      setConversations(prev => sortByRecent(prev.map(conv =>
        conv.id === msg.conversationId
          ? { ...conv, lastMessagePreview: msg.content.slice(0, 100), lastMessageAt: msg.createdAt }
          : conv
      )));
      // Unread bump: only if msg is for a non-active conv and not from us.
      if (msg.conversationId !== activeConvIdRef.current && msg.senderId !== currentUser?.userId) {
        setUnreadByConv(prev => {
          const next = new Map(prev);
          next.set(msg.conversationId, (next.get(msg.conversationId) ?? 0) + 1);
          return next;
        });
      }
      // Advance the sync cursor so we don't re-fetch this message on next reconnect.
      if (msg.createdAt && msg.createdAt > lastSyncAtRef.current) {
        lastSyncAtRef.current = msg.createdAt;
      }
    };

    const onConversationCreated = (e: ConversationEvent) => {
      const conv = e.conversation;
      if (!conv?.id) return;
      setConversations(prev => {
        const idx = prev.findIndex(c => c.id === conv.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...conv };
          return sortByRecent(next);
        }
        return sortByRecent([conv, ...prev]);
      });
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
    const onProfileUpdated = (e: { userId: string; name?: string; statusMessage?: string }) => {
      // Update participant info in every conversation that has this user.
      setConversations(prev => prev.map(conv => {
        if (!conv.participants?.some(p => p.user.id === e.userId)) return conv;
        return {
          ...conv,
          participants: conv.participants.map(p =>
            p.user.id === e.userId
              ? { ...p, user: { ...p.user, name: e.name ?? p.user.name, statusMessage: e.statusMessage ?? p.user.statusMessage } }
              : p
          ),
        };
      }));
    };

    // message:updated — edit or soft-delete (OpenChat-q9h)
    const onMessageUpdated = (msg: Message) => {
      if (msg.conversationId === activeConvIdRef.current) {
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, ...msg } : m));
      }
    };

    // message:reactions-updated — reaction add/remove (OpenChat-7bd)
    const onReactionsUpdated = (payload: { messageId: string; conversationId: string; reactions: ReactionSummary[] }) => {
      if (payload.conversationId === activeConvIdRef.current) {
        setMessages(prev => prev.map(m =>
          m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m
        ));
      }
    };

    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    sock.on('message:new', onMessage);
    sock.on('message:updated', onMessageUpdated);
    sock.on('message:reactions-updated', onReactionsUpdated);
    sock.on('conversation:created', onConversationCreated);
    sock.on('conversation:updated', onConversationUpdated);
    sock.on('participant:added', onParticipantAdded);
    sock.on('participant:removed', onParticipantRemoved);
    sock.on('typing:start', onTypingStart);
    sock.on('typing:stop', onTypingStop);
    sock.on('presence:updated', onPresence);
    sock.on('read:updated', onReadUpdated);
    sock.on('user:profile-updated', onProfileUpdated);

    setIsConnected(sock.connected);

    return () => {
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.off('message:new', onMessage);
      sock.off('message:updated', onMessageUpdated);
      sock.off('message:reactions-updated', onReactionsUpdated);
      sock.off('conversation:created', onConversationCreated);
      sock.off('conversation:updated', onConversationUpdated);
      sock.off('participant:added', onParticipantAdded);
      sock.off('participant:removed', onParticipantRemoved);
      sock.off('typing:start', onTypingStart);
      sock.off('typing:stop', onTypingStop);
      sock.off('presence:updated', onPresence);
      sock.off('read:updated', onReadUpdated);
      sock.off('user:profile-updated', onProfileUpdated);
    };
  }, [isAuthed, currentUser?.userId, refreshConversations]);

  // setActiveConversation: clears unread, joins/leaves rooms, loads messages.
  const setActiveConversation = useCallback((id: string | null) => {
    const prev = activeConvIdRef.current;
    if (prev && prev !== id) leaveConversation(prev);

    activeConvIdRef.current = id;
    setActiveConversationIdState(id);

    if (id) {
      joinConversation(id);
      setUnreadByConv(curr => {
        if (!curr.has(id)) return curr;
        const next = new Map(curr);
        next.delete(id);
        return next;
      });
      setLoadingMessages(true);
      setHasMoreMessages(false);
      api.getMessages(id)
        .then(({ messages: msgs, hasMore }) => {
          if (activeConvIdRef.current === id) {
            setMessages(msgs);
            setHasMoreMessages(hasMore);
            // Advance sync cursor to the most recent message in this conversation.
            if (msgs.length > 0) {
              const latest = msgs[msgs.length - 1].createdAt;
              if (latest && latest > lastSyncAtRef.current) {
                lastSyncAtRef.current = latest;
              }
            }
          }
        })
        .catch(err => console.warn('[ChatContext] loadMessages failed:', err))
        .finally(() => setLoadingMessages(false));
    } else {
      setMessages([]);
      setHasMoreMessages(false);
    }
  }, []);

  // Load older messages for the active conversation (OpenChat-vjc).
  // Uses the createdAt of the earliest currently-loaded message as the cursor.
  // Prepends results to the message list; deduplicates by id in case of overlap.
  const loadOlderMessages = useCallback(async (conversationId: string) => {
    if (loadingOlderMessages || !hasMoreMessages) return;
    // Find the oldest message currently in state (messages are sorted oldest→newest).
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlderMessages(true);
    try {
      const { messages: older, hasMore } = await api.getMessagesBefore(conversationId, oldest.createdAt);
      if (activeConvIdRef.current === conversationId) {
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const newMsgs = older.filter(m => !existingIds.has(m.id));
          return [...newMsgs, ...prev];
        });
        setHasMoreMessages(hasMore);
      }
    } catch (err) {
      console.warn('[ChatContext] loadOlderMessages failed:', err);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [loadingOlderMessages, hasMoreMessages, messages]);

  // Optimistic send: append a local message immediately, then replace with
  // server canonical on success. Accepts optional replyToId for threaded replies
  // (OpenChat-uxj). Server support is a follow-up; the field is passed through
  // in the socket payload so it round-trips once the server handles it.
  const sendMessage = useCallback(async (content: string, replyToId?: string, attachments?: Attachment[]) => {
    const id = activeConvIdRef.current;
    const hasText = !!content.trim();
    const hasAttachments = !!attachments?.length;
    if (!id || (!hasText && !hasAttachments)) return;

    const optimistic: Message = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      conversationId: id,
      senderId: currentUser?.userId || 'me',
      createdAt: new Date().toISOString(),
      sender: currentUser ? { id: currentUser.userId, email: currentUser.email, name: currentUser.name } : undefined,
      replyToId,
      attachments,
    };
    setMessages(prev => [...prev, optimistic]);

    // If there are attachments, always use REST (socket path doesn't carry them).
    if (hasAttachments) {
      try {
        const real = await api.sendMessage(id, content, attachments);
        setMessages(prev => {
          const filtered = prev.filter(m => m.id !== optimistic.id);
          return filtered.some(m => m.id === real.id) ? filtered : [...filtered, real];
        });
      } catch (e2) {
        console.warn('[ChatContext] attachment message send failed:', e2);
        setMessages(prev => prev.map(m => m.id === optimistic.id ? { ...m, _failed: true } as Message & { _failed?: boolean } : m));
        throw e2;
      }
      return;
    }

    // Text-only path: try socket first, fall back to REST.
    try {
      const real = await wsSend(id, content, replyToId);
      // Replace the optimistic placeholder with the server message.
      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== optimistic.id);
        return filtered.some(m => m.id === real.id) ? filtered : [...filtered, real];
      });
    } catch (e) {
      // Socket path failed — try REST fallback.
      try {
        const real = await api.sendMessage(id, content);
        setMessages(prev => {
          const filtered = prev.filter(m => m.id !== optimistic.id);
          return filtered.some(m => m.id === real.id) ? filtered : [...filtered, real];
        });
      } catch (e2) {
        // Mark optimistic as failed (caller will see it didn't disappear).
        console.warn('[ChatContext] message send failed:', e2);
        // Tag the optimistic message; UI can render a retry affordance.
        setMessages(prev => prev.map(m => m.id === optimistic.id ? { ...m, _failed: true } as Message & { _failed?: boolean } : m));
        throw e2;
      }
    }
  }, [currentUser]);

  const createConversation = useCallback(async (
    participantIds: string[],
    opts?: { title?: string; type?: 'direct' | 'group' }
  ) => {
    const type: 'direct' | 'group' = opts?.type ?? (participantIds.length > 1 ? 'group' : 'direct');
    const conv = await api.createConversation(participantIds, opts?.title, type);
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === conv.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...conv };
        return sortByRecent(next);
      }
      return sortByRecent([conv, ...prev]);
    });
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
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, ...updated } : m));
  }, []);

  // Soft-delete own message (OpenChat-q9h). Calls DELETE; server emits message:updated.
  const deleteMessage = useCallback(async (messageId: string) => {
    const updated = await api.deleteMessage(messageId);
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, ...updated } : m));
  }, []);

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
    setMessages(prev => prev.map(m =>
      m.id === messageId ? { ...m, reactions: result.reactions } : m
    ));
  }, [messages]);

  // Block user (OpenChat-46p). Calls API, then removes the DM conversation
  // with that user from the local list so the UI updates immediately.
  const blockUser = useCallback(async (userId: string) => {
    await api.blockUser(userId);
    // Remove any direct conversation with the blocked user from the list.
    setConversations(prev => prev.filter(conv => {
      if (conv.type !== 'direct') return true;
      return !conv.participants?.some(p => p.user.id === userId);
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

  // Mute / unmute a conversation (OpenChat-aes). Local-only for now; server
  // endpoint (PATCH /api/chat/conversations/:id/participants/me { mutedUntil })
  // can be wired in a follow-up once the server side lands.
  const muteConv = useCallback(async (convId: string, until: Date | 'always' | null) => {
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
  }, []);

  // Mark conversation as read (OpenChat-0nj).
  // Debounced 500ms so we don't hammer the server on every incoming message
  // while the user is actively in the conversation.
  const markConversationRead = useCallback((conversationId: string) => {
    const timers = markReadTimers.current;
    const existing = timers.get(conversationId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(conversationId);
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
  }, []);

  // Update own profile (OpenChat-tml).
  const updateProfile = useCallback(async (fields: { name?: string; statusMessage?: string }) => {
    const updated = await api.updateProfile(fields);
    // Optimistically patch currentUser in memory so the UI sees the change immediately.
    setCurrentUser(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        name: updated.name ?? prev.name,
      };
    });
    // Also update the user's own participant entry in conversations.
    if (currentUser) {
      setConversations(prev => prev.map(conv => {
        if (!conv.participants?.some(p => p.user.id === currentUser.userId)) return conv;
        return {
          ...conv,
          participants: conv.participants.map(p =>
            p.user.id === currentUser.userId
              ? { ...p, user: { ...p.user, name: updated.name ?? p.user.name, statusMessage: updated.statusMessage ?? p.user.statusMessage } }
              : p
          ),
        };
      }));
    }
  }, [currentUser]);

  const signOut = useCallback(async () => {
    try { emitPresenceUpdate('offline'); } catch { /* best effort */ }
    disconnect();
    await clearSession();
    setIsAuthed(false);
    setCurrentUser(null);
    setConversations([]);
    setConversationsLoaded(false);
    setMessages([]);
    setHasMoreMessages(false);
    setLoadingOlderMessages(false);
    setActiveConversationIdState(null);
    setPresence(new Map());
    setTypingByConv(new Map());
    setUnreadByConv(new Map());
    setAiDisclosureAcceptedAt(null);
    setReadByOthers(new Map());
    setOnlineUsers(new Map());
    setReconnectNewConvIds(new Set());
    wasEverConnectedRef.current = false;
    lastSyncAtRef.current = new Date().toISOString();
  }, []);

  // 401/403 cascade. Any API call that gets back a token-expired response
  // flips us to Login. Listener is global because requests can fire from
  // anywhere — context handler, screen-level fallbacks, etc.
  useEffect(() => {
    const off = onAuthExpired(() => { void signOut(); });
    return off;
  }, [signOut]);

  const value = useMemo<ChatContextValue>(() => ({
    currentUser, isAuthed, isConnected,
    conversations, conversationsLoaded, refreshConversations,
    createConversation, renameConversation, addParticipant, removeParticipant,
    activeConversationId, setActiveConversation, messages, loadingMessages,
    loadOlderMessages, hasMoreMessages, loadingOlderMessages,
    sendMessage,
    editMessage, deleteMessage,
    toggleReaction,
    blockUser,
    presence, typingByConv, reportTyping, unreadByConv,
    aiDisclosureAcceptedAt, acceptAiDisclosure,
    mutedConvs, muteConv,
    readByOthers, onlineUsers, markConversationRead,
    updateProfile,
    reconnectNewConvIds,
    signOut, bootstrapIfAuthed,
  }), [
    currentUser, isAuthed, isConnected,
    conversations, conversationsLoaded, refreshConversations,
    createConversation, renameConversation, addParticipant, removeParticipant,
    activeConversationId, setActiveConversation, messages, loadingMessages,
    loadOlderMessages, hasMoreMessages, loadingOlderMessages,
    sendMessage,
    editMessage, deleteMessage,
    toggleReaction,
    blockUser,
    presence, typingByConv, reportTyping, unreadByConv,
    aiDisclosureAcceptedAt, acceptAiDisclosure,
    mutedConvs, muteConv,
    readByOthers, onlineUsers, markConversationRead,
    updateProfile,
    reconnectNewConvIds,
    signOut, bootstrapIfAuthed,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Avoid `Status` lint complaint when unused upstream.
export type { Status };
