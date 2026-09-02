import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, type AgentMatch, Attachment, Conversation, isAuthError, Message, User } from '../api';
import { useChatSocket } from '../hooks/useChatSocket';
import {
  clearStoredSession,
  decodeJwtPayload,
  getStoredToken,
  getStoredUser,
  rememberAuthNotice,
} from '../utils/authSession';

interface ChatContextValue {
  // Auth
  token: string | null;
  currentUser: { userId: string; email: string; name?: string } | null;
  login: (token: string) => boolean;
  noosLogin: (email: string, password: string) => Promise<void>;
  noosRegister: (email: string, password: string, name: string) => Promise<void>;
  devLogin: (email: string, name?: string) => Promise<void>;
  ssoLogin: (payload: { code?: string; token?: string }) => Promise<void>;
  startGoogleSignIn: (opts?: { redirect?: string }) => Promise<void>;
  finishGoogleSignIn: (code: string, redirectUri: string) => Promise<void>;
  logout: () => void;

  // Connection
  isConnected: boolean;

  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;
  setActiveConversation: (id: string | null) => void;
  createConversation: (participantIds: string[], title?: string, type?: 'direct' | 'group') => Promise<Conversation>;
  loadConversations: () => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  addParticipant: (conversationId: string, userId: string) => Promise<void>;
  removeParticipant: (conversationId: string, userId: string) => Promise<void>;
  setConversationMute: (conversationId: string, mutedUntil: Date | 'always' | null) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;

  // Load-older pagination (bmp.9)
  loadOlderMessages: () => Promise<void>;
  hasMoreMessages: boolean;
  loadingOlder: boolean;

  // Messages
  messages: Message[];
  sendMessage: (content: string, attachments?: Attachment[]) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;

  // Reply / quote (openchat-bmp.2)
  replyTo: Message | null;
  setReplyTo: (message: Message | null) => void;

  // Contacts
  contacts: User[];
  loadContacts: (search?: string) => Promise<void>;
  searchContacts: (query: string) => Promise<User[]>;

  // Presence
  presence: Map<string, { status: string; statusMessage?: string }>;
  updatePresence: (status: string, statusMessage?: string) => void;

  // Typing
  typingUsers: Map<string, Set<string>>; // conversationId -> userIds
  startTyping: (conversationId: string) => void;
  stopTyping: (conversationId: string) => void;

  // Unread counts per conversation (OpenChat-yg8 / openchat-bmp.4)
  unreadByConv: Map<string, number>;
  // Per-conversation map of userId -> their lastReadAt ISO timestamp, used to
  // render read receipts on the sender's own messages (openchat-bmp.4).
  readReceiptsByConv: Map<string, Record<string, string | null>>;

  // Agent-network matches are always privacy-safe per-viewer projections.
  matches: Map<string, AgentMatch>;
  pendingMatchCount: number;
  refreshMatches: () => Promise<void>;
  updateMatch: (match: AgentMatch) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

function sortByRecent(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });
}

export function ChatProvider({ children }: { children: ReactNode }) {
  // Auth state
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [currentUser, setCurrentUser] = useState<{ userId: string; email: string; name?: string } | null>(() => {
    return token ? getStoredUser() : null;
  });

  // Data state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contacts, setContacts] = useState<User[]>([]);
  const [presence, setPresence] = useState<Map<string, { status: string; statusMessage?: string }>>(new Map());
  const [typingUsers, setTypingUsers] = useState<Map<string, Set<string>>>(new Map());
  const [unreadByConv, setUnreadByConv] = useState<Map<string, number>>(new Map());
  const [readReceiptsByConv, setReadReceiptsByConv] = useState<Map<string, Record<string, string | null>>>(new Map());
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [matches, setMatches] = useState<Map<string, AgentMatch>>(new Map());
  // Load-older pagination state (bmp.9).
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Timestamp of the newest message we've seen, for reconnect catch-up (bmp.9).
  const lastMessageAtRef = useRef<string | null>(null);

  // Mirror the active conversation id into a ref so socket callbacks (whose
  // identities we don't want to churn on every conversation switch) can read
  // the latest value without being re-created. activeConversationId is the
  // source of truth for React rendering; this ref is the source of truth for
  // imperative socket-handler logic (unread bump, mark-read).
  const activeConvRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);
  const missingConversationFetchesRef = useRef<Set<string>>(new Set());
  // markConversationRead is defined later; this ref lets the stable socket
  // handler call the latest version without depending on it. (openchat-bmp.4)
  const markConversationReadRef = useRef<((id: string) => void) | null>(null);

  const clearSession = useCallback(() => {
    setToken(null);
    setCurrentUser(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessages([]);
    setContacts([]);
    setPresence(new Map());
    setTypingUsers(new Map());
    setUnreadByConv(new Map());
    setReadReceiptsByConv(new Map());
    setReplyTo(null);
    setMatches(new Map());
    clearStoredSession();
    api.setToken(null);
  }, []);

  // Keep currentUserId ref in sync for use inside socket handlers.
  useEffect(() => {
    currentUserIdRef.current = currentUser?.userId ?? null;
  }, [currentUser?.userId]);

  const fetchMissingConversationForMessage = useCallback((message: Message) => {
    const conversationId = message.conversationId;
    if (missingConversationFetchesRef.current.has(conversationId)) return;
    missingConversationFetchesRef.current.add(conversationId);

    api.getConversation(conversationId)
      .then(conv => {
        setConversations(prev => {
          const nextConv = {
            ...conv,
            lastMessagePreview: message.content.slice(0, 100),
            lastMessageAt: message.createdAt,
          };
          const idx = prev.findIndex(c => c.id === conversationId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...nextConv };
            return sortByRecent(next);
          }
          return sortByRecent([nextConv, ...prev]);
        });
      })
      .catch(e => {
        if (!isAuthError(e)) console.error('Failed to fetch conversation for incoming message:', e);
      })
      .finally(() => {
        missingConversationFetchesRef.current.delete(conversationId);
      });
  }, []);

  // Socket handlers
  const handleMessage = useCallback((message: Message) => {
    // Track newest message timestamp for reconnect catch-up (bmp.9).
    if (!lastMessageAtRef.current || message.createdAt > lastMessageAtRef.current) {
      lastMessageAtRef.current = message.createdAt;
    }
    setMessages(prev => {
      if (message.conversationId === activeConvRef.current) {
        // Add to current conversation
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      }
      return prev;
    });

    // Update conversation preview
    setConversations(prev => {
      let found = false;
      const next = prev.map(conv => {
        if (conv.id === message.conversationId) {
          found = true;
          return {
            ...conv,
            lastMessagePreview: message.content.slice(0, 100),
            lastMessageAt: message.createdAt,
          };
        }
        return conv;
      });
      if (!found) {
        fetchMissingConversationForMessage(message);
      }
      return sortByRecent(next);
    });

    // Unread bookkeeping (openchat-bmp.4). Bump the per-conversation unread
    // count when the message lands in a conversation that ISN'T currently
    // open and wasn't sent by me. Use the refs so this callback keeps a
    // stable identity (we don't want to tear down the socket on every
    // conversation switch). If the conversation IS active, the read is
    // immediate — handled by the markRead effect — so don't bump.
    const isActive = message.conversationId === activeConvRef.current;
    const isMine = message.senderId === currentUserIdRef.current;
    if (!isActive && !isMine) {
      setUnreadByConv(prev => {
        const next = new Map(prev);
        next.set(message.conversationId, (next.get(message.conversationId) ?? 0) + 1);
        return next;
      });
    } else if (isActive && !isMine) {
      // The conversation is open and someone else sent a message — mark read
      // immediately so their tick advances to "read" (parity with mobile).
      markConversationReadRef.current?.(message.conversationId);
    }
  }, [fetchMissingConversationForMessage]);

  // Edit / soft-delete echo (openchat-bmp.3). Replace the message in place in
  // the active conversation's list. We match on id; deletes arrive as a
  // normal message with deletedAt set + content "Message deleted".
  const handleMessageUpdated = useCallback((message: Message) => {
    setMessages(prev => {
      if (!prev.some(m => m.id === message.id)) return prev;
      return prev.map(m => (m.id === message.id ? { ...m, ...message } : m));
    });
    // Refresh the sidebar preview if this was the latest message.
    setConversations(prev => prev.map(conv => {
      if (conv.id !== message.conversationId) return conv;
      return { ...conv, lastMessagePreview: (message.content || '').slice(0, 100) };
    }));
  }, []);

  // Reaction counts changed (openchat-bmp.1). Patch the reactions array on the
  // target message if it's loaded.
  const handleReactionsUpdated = useCallback((data: { messageId: string; conversationId: string; reactions: Message['reactions'] }) => {
    setMessages(prev => prev.map(m => (m.id === data.messageId ? { ...m, reactions: data.reactions } : m)));
  }, []);

  // A participant marked the conversation read (openchat-bmp.4). Store their
  // lastReadAt so the sender can render read receipts.
  const handleReadUpdated = useCallback((data: { conversationId: string; readMap?: Record<string, string | null>; userId: string; lastReadAt: string }) => {
    setReadReceiptsByConv(prev => {
      const next = new Map(prev);
      const existing = { ...(next.get(data.conversationId) ?? {}) };
      if (data.readMap) {
        next.set(data.conversationId, { ...existing, ...data.readMap });
      } else {
        existing[data.userId] = data.lastReadAt;
        next.set(data.conversationId, existing);
      }
      return next;
    });
  }, []);

  // A voice message was auto-transcribed (openchat-4jn). Patch the transcript
  // onto the message if it's loaded so the caption appears live without a
  // reload.
  const handleTranscript = useCallback((data: { messageId: string; conversationId: string; transcript: string }) => {
    setMessages(prev => prev.map(m => (m.id === data.messageId ? { ...m, transcript: data.transcript } : m)));
  }, []);

  const updateMatch = useCallback((match: AgentMatch) => {
    setMatches(prev => {
      const next = new Map(prev);
      next.set(match.id, match);
      return next;
    });
  }, []);

  const handleMatchUpdated = useCallback((data: { match: AgentMatch }) => {
    updateMatch(data.match);
  }, [updateMatch]);

  const refreshMatches = useCallback(async () => {
    if (!token) {
      setMatches(new Map());
      return;
    }
    const latest = await api.listMatches();
    setMatches(new Map(latest.map(match => [match.id, match])));
  }, [token]);

  const handleTypingStart = useCallback((data: { conversationId: string; userId: string }) => {
    setTypingUsers(prev => {
      const newMap = new Map(prev);
      const users = newMap.get(data.conversationId) || new Set();
      users.add(data.userId);
      newMap.set(data.conversationId, users);
      return newMap;
    });
  }, []);

  const handleTypingStop = useCallback((data: { conversationId: string; userId: string }) => {
    setTypingUsers(prev => {
      const newMap = new Map(prev);
      const users = newMap.get(data.conversationId);
      if (users) {
        users.delete(data.userId);
        if (users.size === 0) {
          newMap.delete(data.conversationId);
        } else {
          newMap.set(data.conversationId, users);
        }
      }
      return newMap;
    });
  }, []);

  const handlePresenceUpdate = useCallback((data: { userId: string; status: string; statusMessage?: string }) => {
    setPresence(prev => {
      const newMap = new Map(prev);
      newMap.set(data.userId, { status: data.status, statusMessage: data.statusMessage });
      return newMap;
    });

    // Update contacts list
    setContacts(prev => prev.map(c => {
      if (c.id === data.userId) {
        return { ...c, presenceStatus: data.status, statusMessage: data.statusMessage };
      }
      return c;
    }));
  }, []);

  // Conversation created (e.g. someone added me to a new group, or my own
  // create echoed back from server). Idempotent merge.
  const handleConversationCreated = useCallback((data: { conversationId: string; conversation: unknown }) => {
    const conv = data.conversation as Conversation;
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
  }, []);

  const handleConversationUpdated = useCallback((data: { conversationId: string; conversation: unknown }) => {
    const conv = data.conversation as Conversation;
    if (!conv?.id) return;
    setConversations(prev => sortByRecent(prev.map(c => (c.id === conv.id ? { ...c, ...conv } : c))));
  }, []);

  const handleParticipantAdded = useCallback((data: { conversationId: string; conversation: unknown }) => {
    const conv = data.conversation as Conversation;
    if (!conv?.id) return;
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === conv.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...conv };
        return sortByRecent(next);
      }
      // We were just added — insert.
      return sortByRecent([conv, ...prev]);
    });
  }, []);

  const handleParticipantRemoved = useCallback((data: { conversationId: string; userId: string; conversation?: unknown }) => {
    const conv = data.conversation as Conversation | undefined;
    // If *I* was the one removed, drop the conversation entirely from my view.
    const me = JSON.parse(localStorage.getItem('openchat_user') || 'null') as { userId?: string } | null;
    if (data.userId === me?.userId) {
      setConversations(prev => prev.filter(c => c.id !== data.conversationId));
      setActiveConversationId(curr => (curr === data.conversationId ? null : curr));
      toast('You were removed from the group');
      return;
    }
    setConversations(prev => prev.map(c => {
      if (c.id !== data.conversationId) return c;
      if (conv) return { ...c, ...conv };
      return {
        ...c,
        participants: (c.participants || []).filter(p => p.user.id !== data.userId),
      };
    }));
  }, []);

  const {
    isConnected,
    joinConversation,
    leaveConversation,
    sendMessage: socketSendMessage,
    updatePresence: socketUpdatePresence,
    startTyping,
    stopTyping,
  } = useChatSocket({
    token,
    onMessage: handleMessage,
    onTypingStart: handleTypingStart,
    onTypingStop: handleTypingStop,
    onPresenceUpdate: handlePresenceUpdate,
    onConversationCreated: handleConversationCreated,
    onConversationUpdated: handleConversationUpdated,
    onParticipantAdded: handleParticipantAdded,
    onParticipantRemoved: handleParticipantRemoved,
    onMessageUpdated: handleMessageUpdated,
    onReactionsUpdated: handleReactionsUpdated,
    onReadUpdated: handleReadUpdated,
    onTranscript: handleTranscript,
    onMatchUpdated: handleMatchUpdated,
  });

  // Set API token when auth changes
  useEffect(() => {
    api.setToken(token);
    if (!token) {
      setMatches(new Map());
      return;
    }

    // Seed the sidebar badge on sign-in. Overlay opens perform their own
    // authoritative refresh because socket delivery is best-effort.
    let cancelled = false;
    api.listMatches()
      .then(latest => {
        if (!cancelled) setMatches(new Map(latest.map(match => [match.id, match])));
      })
      .catch(error => {
        if (!cancelled && !isAuthError(error)) console.error('Failed to load agent matches:', error);
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    api.setAuthErrorHandler(() => {
      rememberAuthNotice();
      clearSession();
    });
    return () => api.setAuthErrorHandler(null);
  }, [clearSession]);

  // Login with token
  const login = useCallback((newToken: string): boolean => {
    // Decode JWT to get user info (basic decode, not verification)
    try {
      const payload = decodeJwtPayload(newToken);
      if (!payload.userId || !payload.email) {
        throw new Error('JWT missing required user fields');
      }
      const user = { userId: payload.userId, email: payload.email };
      setCurrentUser(user);
      setToken(newToken);
      localStorage.setItem('openchat_token', newToken);
      localStorage.setItem('openchat_user', JSON.stringify(user));
      return true;
    } catch (e) {
      console.error('Invalid token:', e);
      return false;
    }
  }, []);

  // Noos login with email/password
  const noosLogin = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    const user = { userId: result.user.id, email: result.user.email, name: result.user.name };
    setCurrentUser(user);
    setToken(result.token);
    localStorage.setItem('openchat_token', result.token);
    localStorage.setItem('openchat_user', JSON.stringify(user));
    if (result.refreshToken) {
      localStorage.setItem('openchat_refresh_token', result.refreshToken);
    }
    toast.success('Logged in successfully');
  }, []);

  // Noos registration
  const noosRegister = useCallback(async (email: string, password: string, name: string) => {
    const result = await api.register(email, password, name);
    const user = { userId: result.user.id, email: result.user.email, name: result.user.name };
    setCurrentUser(user);
    setToken(result.token);
    localStorage.setItem('openchat_token', result.token);
    localStorage.setItem('openchat_user', JSON.stringify(user));
    toast.success('Account created successfully');
  }, []);

  // Dev login with email (creates user if needed) - for development only
  const devLogin = useCallback(async (email: string, name?: string) => {
    const result = await api.devLogin(email, name);
    const user = { userId: result.user.id, email: result.user.email, name: result.user.name };
    setCurrentUser(user);
    setToken(result.token);
    localStorage.setItem('openchat_token', result.token);
    localStorage.setItem('openchat_user', JSON.stringify(user));
  }, []);

  // SSO login - exchange Noos SSO code/token for session
  const ssoLogin = useCallback(async (payload: { code?: string; token?: string }) => {
    const result = await api.ssoExchange(payload);
    const user = { userId: result.user.id, email: result.user.email, name: result.user.name };
    setCurrentUser(user);
    setToken(result.token);
    localStorage.setItem('openchat_token', result.token);
    localStorage.setItem('openchat_user', JSON.stringify(user));
  }, []);

  // Google: kick off the OAuth redirect. We stash state + redirect target
  // in sessionStorage; the callback page reads them.
  const startGoogleSignIn = useCallback(async (opts?: { redirect?: string }) => {
    const stateSeed = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    const callbackUrl = new URL('/auth/google/callback', window.location.origin).toString();
    const { url, state, redirectUri } = await api.googleAuthUrl({
      state: stateSeed,
      redirectUri: callbackUrl,
    });
    sessionStorage.setItem('openchat_google_oauth', JSON.stringify({
      state,
      redirectUri,
      redirect: opts?.redirect || '/',
    }));
    window.location.assign(url);
  }, []);

  // Google: handle the OAuth callback — exchange code for a session.
  const finishGoogleSignIn = useCallback(async (code: string, redirectUri: string) => {
    const result = await api.googleExchange(code, redirectUri);
    const user = { userId: result.user.id, email: result.user.email, name: result.user.name };
    setCurrentUser(user);
    setToken(result.token);
    localStorage.setItem('openchat_token', result.token);
    localStorage.setItem('openchat_user', JSON.stringify(user));
    toast.success(`Signed in with Google as ${user.email}`);
  }, []);

  // Logout
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Ignore errors
    }
    clearSession();
  }, [clearSession]);

  // Load conversations
  const loadConversations = useCallback(async () => {
    if (!token) return;
    api.setToken(token);

    try {
      const data = await api.getConversations();
      setConversations(sortByRecent(data));
      const seededPresence = new Map<string, { status: string; statusMessage?: string }>();
      for (const conv of data) {
        for (const participant of conv.participants || []) {
          const user = participant.user;
          if (user?.presenceStatus) {
            seededPresence.set(user.id, {
              status: user.presenceStatus,
              statusMessage: user.statusMessage || undefined,
            });
          }
        }
      }
      if (seededPresence.size > 0) {
        setPresence(prev => {
          const merged = new Map(prev);
          seededPresence.forEach((value, key) => merged.set(key, value));
          return merged;
        });
      }
    } catch (e) {
      console.error('Failed to load conversations:', e);
      if (isAuthError(e)) return;
      toast.error('Failed to load conversations');
    }
  }, [token]);

  // Load messages for a conversation (newest page)
  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const { messages: data, hasMore } = await api.getMessages(conversationId);
      setMessages(data);
      setHasMoreMessages(!!hasMore);
      // Seed the newest-seen timestamp for reconnect catch-up (bmp.9).
      const newest = data.length ? data[data.length - 1].createdAt : null;
      if (newest) lastMessageAtRef.current = newest;
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, []);

  // Load an older page of messages, prepending to the list (bmp.9). Uses the
  // `before` cursor (oldest currently-loaded message id). listMessages returns
  // messages oldest→newest, so the oldest is messages[0].
  const loadOlderMessages = useCallback(async () => {
    const convId = activeConvRef.current;
    if (!convId || loadingOlder || !hasMoreMessages) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[0];
      if (!oldest) return;
      // Server's `before` is a createdAt cursor (WHERE m.createdAt < datetime($before)).
      const { messages: older, hasMore } = await api.getMessages(convId, 50, oldest.createdAt);
      setHasMoreMessages(!!hasMore);
      if (older.length) {
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          const dedup = older.filter(m => !seen.has(m.id));
          return [...dedup, ...prev];
        });
      }
    } catch (e) {
      console.error('Failed to load older messages:', e);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMoreMessages, messages]);

  // Mark a conversation read: clears the local unread badge and tells the
  // server (which broadcasts read:updated so other participants can render
  // read receipts). Best-effort — a failed PATCH just leaves the badge, and
  // the next open retries. (openchat-bmp.4)
  const markConversationRead = useCallback(async (id: string) => {
    setUnreadByConv(prev => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      const result = await api.markConversationRead(id);
      if (result?.readMap) {
        setReadReceiptsByConv(prev => {
          const next = new Map(prev);
          next.set(id, { ...(next.get(id) ?? {}), ...result.readMap });
          return next;
        });
      }
    } catch (e) {
      if (!isAuthError(e)) console.error('Failed to mark conversation read:', e);
    }
  }, []);

  // Expose markConversationRead to the stable socket handler via ref.
  useEffect(() => {
    markConversationReadRef.current = markConversationRead;
  }, [markConversationRead]);

  // Reconnect catch-up (bmp.9). When the socket reconnects after a drop, fetch
  // any messages that landed during the gap so we don't silently miss them.
  // `truncated` means too many to merge — fall back to a full conversation
  // refresh (and reload the active thread).
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // Transitioned disconnected → connected.
      const since = lastMessageAtRef.current;
      if (since && token) {
        api.messagesSince(since)
          .then(({ messages: missed, truncated }) => {
            if (truncated) {
              void loadConversations();
              const active = activeConvRef.current;
              if (active) void loadMessages(active);
              return;
            }
            if (!missed.length) return;
            const active = activeConvRef.current;
            for (const m of missed) {
              if (m.createdAt > (lastMessageAtRef.current ?? '')) lastMessageAtRef.current = m.createdAt;
            }
            // Append any missed messages for the active conversation.
            setMessages(prev => {
              const seen = new Set(prev.map(x => x.id));
              const add = missed.filter(m => m.conversationId === active && !seen.has(m.id));
              return add.length ? [...prev, ...add] : prev;
            });
            // Refresh sidebar previews/unread by reloading conversations.
            void loadConversations();
          })
          .catch(e => { if (!isAuthError(e)) console.error('Reconnect catch-up failed:', e); });
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, token, loadConversations, loadMessages]);

  // Set active conversation
  const setActiveConversation = useCallback((id: string | null) => {
    if (activeConversationId) {
      leaveConversation(activeConversationId);
    }
    setActiveConversationId(id);
    activeConvRef.current = id;
    // Clear any pending reply when switching conversations.
    setReplyTo(null);
    if (id) {
      joinConversation(id);
      loadMessages(id);
      void markConversationRead(id);
    } else {
      setMessages([]);
    }
  }, [activeConversationId, joinConversation, leaveConversation, loadMessages, markConversationRead]);

  // Create conversation
  const createConversation = useCallback(async (participantIds: string[], title?: string, type?: 'direct' | 'group') => {
    // Auto-derive type from participant count if not given: 1 -> direct, 2+ -> group
    const resolvedType: 'direct' | 'group' = type ?? (participantIds.length > 1 ? 'group' : 'direct');
    const conv = await api.createConversation(participantIds, title, resolvedType);
    setConversations(prev => {
      // Replace if it already exists (idempotent for repeat 1:1 creates)
      const idx = prev.findIndex(c => c.id === conv.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = conv;
        return sortByRecent(next);
      }
      return sortByRecent([conv, ...prev]);
    });
    return conv;
  }, []);

  // Rename group
  const renameConversation = useCallback(async (id: string, title: string) => {
    const updated = await api.updateConversation(id, { title });
    setConversations(prev => prev.map(c => (c.id === id ? { ...c, ...updated } : c)));
  }, []);

  // Add member to group
  const addParticipant = useCallback(async (conversationId: string, userId: string) => {
    const updated = await api.addParticipant(conversationId, userId);
    setConversations(prev => prev.map(c => (c.id === conversationId ? { ...c, ...updated } : c)));
  }, []);

  // Remove member (or leave, when userId === currentUser)
  const removeParticipant = useCallback(async (conversationId: string, userId: string) => {
    await api.removeParticipant(conversationId, userId);
    if (userId === currentUser?.userId) {
      // Self-leave — drop the conversation locally
      setConversations(prev => prev.filter(c => c.id !== conversationId));
      setActiveConversationId(curr => (curr === conversationId ? null : curr));
    } else {
      // Optimistic local update; the real conversation will arrive via WS
      setConversations(prev => prev.map(c => {
        if (c.id !== conversationId) return c;
        return {
          ...c,
          participants: (c.participants || []).filter(p => p.user.id !== userId),
        };
      }));
    }
  }, [currentUser?.userId]);

  // Mute / unmute a conversation (bmp.5). Optimistic: update local mutedUntil,
  // then PATCH. On failure, reload conversations to reconcile.
  const setConversationMute = useCallback(async (conversationId: string, mutedUntil: Date | 'always' | null) => {
    const optimistic = mutedUntil === null ? null : mutedUntil === 'always' ? 'always' : mutedUntil.toISOString();
    setConversations(prev => prev.map(c => (c.id === conversationId ? { ...c, mutedUntil: optimistic } : c)));
    try {
      const res = await api.setConversationMute(conversationId, mutedUntil);
      setConversations(prev => prev.map(c => (c.id === conversationId ? { ...c, mutedUntil: res.mutedUntil } : c)));
    } catch (e) {
      if (!isAuthError(e)) {
        toast.error('Could not update mute');
        void loadConversations();
      }
    }
  }, [loadConversations]);

  // Block a user (bmp.6). Removes any DM with them from the local list and
  // closes it if open. Server also drops it server-side.
  const blockUser = useCallback(async (userId: string) => {
    await api.blockUser(userId);
    setConversations(prev => prev.filter(c => {
      if (c.type !== 'direct') return true;
      return !(c.participants || []).some(p => p.user.id === userId);
    }));
    setActiveConversationId(curr => {
      const conv = conversations.find(c => c.id === curr);
      const isWithBlocked = conv?.type === 'direct' && (conv.participants || []).some(p => p.user.id === userId);
      return isWithBlocked ? null : curr;
    });
    toast.success('User blocked');
  }, [conversations]);

  // Send message (with optional image attachments — OpenChat-6bg, reply — bmp.2)
  const sendMessage = useCallback(async (content: string, attachments?: Attachment[]) => {
    if (!activeConversationId) return;
    // One idempotency key per logical message, shared by the WebSocket path and
    // the REST fallback, so a lost-ack retry can't persist two rows. See
    // OpenChat-60y.
    const messageId = crypto.randomUUID();
    const replyToId = replyTo?.id;
    // Clear the reply composer immediately — the quote is captured in replyToId.
    if (replyTo) setReplyTo(null);
    // If there are attachments OR a reply target, use REST (the socket path
    // carries neither attachments nor replyToId). Still pass the idempotency id.
    if (attachments?.length || replyToId) {
      const message = await api.sendMessage(activeConversationId, content, 'text', attachments, messageId, replyToId);
      setMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]));
      return;
    }
    try {
      await socketSendMessage(activeConversationId, content, messageId);
    } catch (e) {
      // Fallback to REST API (same id -> server MERGE de-dupes if the WS write
      // actually landed). Dedupe locally too: the REST broadcast may have
      // already inserted this id via handleMessage before the POST resolves.
      const message = await api.sendMessage(activeConversationId, content, 'text', undefined, messageId);
      setMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]));
    }
  }, [activeConversationId, socketSendMessage, replyTo]);

  // Edit own message (openchat-bmp.3). Optimistic: patch locally, then PATCH.
  // The server broadcasts message:updated so other clients converge.
  const editMessage = useCallback(async (messageId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const updated = await api.editMessage(messageId, trimmed);
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, ...updated } : m)));
  }, []);

  // Delete own message (openchat-bmp.3). Soft-delete on the server; it returns
  // the rewritten "Message deleted" message which we splice in.
  const deleteMessage = useCallback(async (messageId: string) => {
    const updated = await api.deleteMessage(messageId);
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, ...updated } : m)));
  }, []);

  // Toggle an emoji reaction (openchat-bmp.1). If I've already reacted with
  // this emoji, remove it; otherwise add it. Optimistic update, reconciled by
  // the server response + message:reactions-updated broadcast.
  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    const target = messages.find(m => m.id === messageId);
    const mine = target?.reactions?.find(r => r.emoji === emoji && r.byMe);
    try {
      const { reactions } = mine
        ? await api.removeReaction(messageId, emoji)
        : await api.addReaction(messageId, emoji);
      setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, reactions } : m)));
    } catch (e) {
      if (!isAuthError(e)) {
        console.error('Failed to toggle reaction:', e);
        toast.error('Could not update reaction');
      }
    }
  }, [messages]);

  // Load contacts (optionally with search query)
  const loadContacts = useCallback(async (search?: string) => {
    try {
      const data = await api.getContacts(search);
      setContacts(data);

      // Initialize presence from contacts
      const newPresence = new Map<string, { status: string; statusMessage?: string }>();
      for (const contact of data) {
        if (contact.presenceStatus) {
          newPresence.set(contact.id, {
            status: contact.presenceStatus,
            statusMessage: contact.statusMessage,
          });
        }
      }
      setPresence(prev => {
        const merged = new Map(prev);
        newPresence.forEach((v, k) => merged.set(k, v));
        return merged;
      });
    } catch (e) {
      console.error('Failed to load contacts:', e);
      if (isAuthError(e)) return;
      toast.error('Failed to load contacts. Check your connection.');
    }
  }, []);

  // Search contacts (returns results without updating state - for debounced search)
  const searchContacts = useCallback(async (query: string): Promise<User[]> => {
    try {
      return await api.getContacts(query);
    } catch (e) {
      console.error('Failed to search contacts:', e);
      if (isAuthError(e)) return [];
      const errorMsg = e instanceof Error ? e.message : 'Unknown error';
      toast.error(`Search failed: ${errorMsg}`);
      return [];
    }
  }, []);

  // Update presence
  const updatePresence = useCallback((status: string, statusMessage?: string) => {
    socketUpdatePresence(status, statusMessage);
    api.updatePresence(status, statusMessage);
  }, [socketUpdatePresence]);

  const value: ChatContextValue = {
    token,
    currentUser,
    login,
    noosLogin,
    noosRegister,
    devLogin,
    ssoLogin,
    startGoogleSignIn,
    finishGoogleSignIn,
    logout,
    isConnected,
    conversations,
    activeConversationId,
    setActiveConversation,
    createConversation,
    loadConversations,
    renameConversation,
    addParticipant,
    removeParticipant,
    setConversationMute,
    blockUser,
    loadOlderMessages,
    hasMoreMessages,
    loadingOlder,
    messages,
    sendMessage,
    loadMessages,
    editMessage,
    deleteMessage,
    toggleReaction,
    replyTo,
    setReplyTo,
    contacts,
    loadContacts,
    searchContacts,
    presence,
    updatePresence,
    typingUsers,
    startTyping,
    stopTyping,
    unreadByConv,
    readReceiptsByConv,
    matches,
    pendingMatchCount: Array.from(matches.values()).filter(match => match.status === 'pending').length,
    refreshMatches,
    updateMatch,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within ChatProvider');
  }
  return context;
}
