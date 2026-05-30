/**
 * ChatContext — the single source of truth for socket lifecycle, conversations,
 * presence, typing, and unread counts in the mobile app.
 *
 * Mirrors the web ChatContext at flinch-sequel/client/src/contexts/ChatContext.tsx
 * but trimmed for mobile + no DOM. The screens consume `useChat()` for state
 * and actions; they shouldn't subscribe to socket events directly.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import {
  api,
  Conversation,
  CurrentUser,
  Message,
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
  sendMessage: (content: string) => Promise<void>;

  // Presence & typing
  presence: Map<string, { status: string; statusMessage?: string }>;
  typingByConv: Map<string, Set<string>>;
  reportTyping: (conversationId: string, isTyping: boolean) => void;

  // Unread counters
  unreadByConv: Map<string, number>;

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

  const [presence, setPresence] = useState<Map<string, { status: string; statusMessage?: string }>>(new Map());
  const [typingByConv, setTypingByConv] = useState<Map<string, Set<string>>>(new Map());
  const [unreadByConv, setUnreadByConv] = useState<Map<string, number>>(new Map());

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
    return true;
  }, [refreshConversations]);

  // Wire socket listeners exactly ONCE per authed session.
  useEffect(() => {
    if (!isAuthed) return;
    const sock = getSocket();
    if (!sock) return;

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

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

    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    sock.on('message:new', onMessage);
    sock.on('conversation:created', onConversationCreated);
    sock.on('conversation:updated', onConversationUpdated);
    sock.on('participant:added', onParticipantAdded);
    sock.on('participant:removed', onParticipantRemoved);
    sock.on('typing:start', onTypingStart);
    sock.on('typing:stop', onTypingStop);
    sock.on('presence:updated', onPresence);

    setIsConnected(sock.connected);

    return () => {
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.off('message:new', onMessage);
      sock.off('conversation:created', onConversationCreated);
      sock.off('conversation:updated', onConversationUpdated);
      sock.off('participant:added', onParticipantAdded);
      sock.off('participant:removed', onParticipantRemoved);
      sock.off('typing:start', onTypingStart);
      sock.off('typing:stop', onTypingStop);
      sock.off('presence:updated', onPresence);
    };
  }, [isAuthed, currentUser?.userId]);

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
      api.getMessages(id)
        .then(msgs => {
          if (activeConvIdRef.current === id) setMessages(msgs);
        })
        .catch(err => console.warn('[ChatContext] loadMessages failed:', err))
        .finally(() => setLoadingMessages(false));
    } else {
      setMessages([]);
    }
  }, []);

  // Optimistic send: append a local message immediately, then replace with
  // server canonical on success.
  const sendMessage = useCallback(async (content: string) => {
    const id = activeConvIdRef.current;
    if (!id || !content.trim()) return;
    const optimistic: Message = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      conversationId: id,
      senderId: currentUser?.userId || 'me',
      createdAt: new Date().toISOString(),
      sender: currentUser ? { id: currentUser.userId, email: currentUser.email, name: currentUser.name } : undefined,
    };
    setMessages(prev => [...prev, optimistic]);
    try {
      const real = await wsSend(id, content);
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

  const signOut = useCallback(async () => {
    try { emitPresenceUpdate('offline'); } catch { /* best effort */ }
    disconnect();
    await clearSession();
    setIsAuthed(false);
    setCurrentUser(null);
    setConversations([]);
    setConversationsLoaded(false);
    setMessages([]);
    setActiveConversationIdState(null);
    setPresence(new Map());
    setTypingByConv(new Map());
    setUnreadByConv(new Map());
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
    activeConversationId, setActiveConversation, messages, loadingMessages, sendMessage,
    presence, typingByConv, reportTyping, unreadByConv,
    signOut, bootstrapIfAuthed,
  }), [
    currentUser, isAuthed, isConnected,
    conversations, conversationsLoaded, refreshConversations,
    createConversation, renameConversation, addParticipant, removeParticipant,
    activeConversationId, setActiveConversation, messages, loadingMessages, sendMessage,
    presence, typingByConv, reportTyping, unreadByConv,
    signOut, bootstrapIfAuthed,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Avoid `Status` lint complaint when unused upstream.
export type { Status };
