import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, Conversation, isAuthError, Message, User } from '../api';
import { useChatSocket } from '../hooks/useChatSocket';

interface ChatContextValue {
  // Auth
  token: string | null;
  currentUser: { userId: string; email: string; name?: string } | null;
  login: (token: string) => boolean;
  noosLogin: (email: string, password: string) => Promise<void>;
  noosRegister: (email: string, password: string, name: string) => Promise<void>;
  devLogin: (email: string, name?: string) => Promise<void>;
  ssoLogin: (payload: { code?: string; token?: string }) => Promise<void>;
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

  // Messages
  messages: Message[];
  sendMessage: (content: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;

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
}

const ChatContext = createContext<ChatContextValue | null>(null);
const AUTH_NOTICE_KEY = 'openchat_auth_notice';
const AUTH_NOTICE_MESSAGE = "You're not logged in. Please sign in with Noos.";

function rememberAuthNotice() {
  sessionStorage.setItem(AUTH_NOTICE_KEY, AUTH_NOTICE_MESSAGE);
}

function clearStoredSession() {
  localStorage.removeItem('openchat_token');
  localStorage.removeItem('openchat_user');
  localStorage.removeItem('openchat_refresh_token');
}

function decodeJwtPayload(token: string): { userId?: string; email?: string; exp?: number } {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('JWT payload missing');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
  return JSON.parse(atob(padded));
}

function getStoredToken(): string | null {
  const stored = localStorage.getItem('openchat_token');
  if (!stored) return null;

  try {
    const payload = decodeJwtPayload(stored);
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      rememberAuthNotice();
      clearStoredSession();
      return null;
    }
    return stored;
  } catch {
    rememberAuthNotice();
    clearStoredSession();
    return null;
  }
}

function getStoredUser(): { userId: string; email: string; name?: string } | null {
  const saved = localStorage.getItem('openchat_user');
  if (!saved) return null;

  try {
    return JSON.parse(saved);
  } catch {
    clearStoredSession();
    return null;
  }
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

  const clearSession = useCallback(() => {
    setToken(null);
    setCurrentUser(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessages([]);
    setContacts([]);
    setPresence(new Map());
    setTypingUsers(new Map());
    clearStoredSession();
    api.setToken(null);
  }, []);

  // Socket handlers
  const handleMessage = useCallback((message: Message) => {
    setMessages(prev => {
      if (message.conversationId === activeConversationId) {
        // Add to current conversation
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      }
      return prev;
    });

    // Update conversation preview
    setConversations(prev => prev.map(conv => {
      if (conv.id === message.conversationId) {
        return {
          ...conv,
          lastMessagePreview: message.content.slice(0, 100),
          lastMessageAt: message.createdAt,
        };
      }
      return conv;
    }));
  }, [activeConversationId]);

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
        return next;
      }
      return [conv, ...prev];
    });
  }, []);

  const handleConversationUpdated = useCallback((data: { conversationId: string; conversation: unknown }) => {
    const conv = data.conversation as Conversation;
    if (!conv?.id) return;
    setConversations(prev => prev.map(c => (c.id === conv.id ? { ...c, ...conv } : c)));
  }, []);

  const handleParticipantAdded = useCallback((data: { conversationId: string; conversation: unknown }) => {
    const conv = data.conversation as Conversation;
    if (!conv?.id) return;
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === conv.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...conv };
        return next;
      }
      // We were just added — insert.
      return [conv, ...prev];
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
  });

  // Set API token when auth changes
  useEffect(() => {
    api.setToken(token);
  }, [token]);

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

    try {
      const data = await api.getConversations();
      setConversations(data);
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
      if (isAuthError(e)) {
        rememberAuthNotice();
        clearSession();
        toast.error(AUTH_NOTICE_MESSAGE, { id: 'openchat-auth-required' });
        return;
      }
      toast.error('Failed to load conversations');
    }
  }, [clearSession, token]);

  // Load messages for a conversation
  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const data = await api.getMessages(conversationId);
      setMessages(data);
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }, []);

  // Set active conversation
  const setActiveConversation = useCallback((id: string | null) => {
    if (activeConversationId) {
      leaveConversation(activeConversationId);
    }
    setActiveConversationId(id);
    if (id) {
      joinConversation(id);
      loadMessages(id);
    } else {
      setMessages([]);
    }
  }, [activeConversationId, joinConversation, leaveConversation, loadMessages]);

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
        return next;
      }
      return [conv, ...prev];
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

  // Send message
  const sendMessage = useCallback(async (content: string) => {
    if (!activeConversationId) return;
    try {
      await socketSendMessage(activeConversationId, content);
    } catch (e) {
      // Fallback to REST API
      const message = await api.sendMessage(activeConversationId, content);
      setMessages(prev => [...prev, message]);
    }
  }, [activeConversationId, socketSendMessage]);

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
      toast.error('Failed to load contacts. Check your connection.');
    }
  }, []);

  // Search contacts (returns results without updating state - for debounced search)
  const searchContacts = useCallback(async (query: string): Promise<User[]> => {
    try {
      return await api.getContacts(query);
    } catch (e) {
      console.error('Failed to search contacts:', e);
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
    messages,
    sendMessage,
    loadMessages,
    contacts,
    loadContacts,
    searchContacts,
    presence,
    updatePresence,
    typingUsers,
    startTyping,
    stopTyping,
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
