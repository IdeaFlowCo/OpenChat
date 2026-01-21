import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { api, Conversation, Message, User } from '../api';
import { useChatSocket } from '../hooks/useChatSocket';

interface ChatContextValue {
  // Auth
  token: string | null;
  currentUser: { userId: string; email: string; name?: string } | null;
  login: (token: string) => void;
  devLogin: (email: string, name?: string) => Promise<void>;
  ssoLogin: (ssoToken: string) => Promise<void>;
  logout: () => void;

  // Connection
  isConnected: boolean;

  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;
  setActiveConversation: (id: string | null) => void;
  createConversation: (participantIds: string[], title?: string) => Promise<Conversation>;
  loadConversations: () => Promise<void>;

  // Messages
  messages: Message[];
  sendMessage: (content: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;

  // Contacts
  contacts: User[];
  loadContacts: () => Promise<void>;

  // Presence
  presence: Map<string, { status: string; statusMessage?: string }>;
  updatePresence: (status: string, statusMessage?: string) => void;

  // Typing
  typingUsers: Map<string, Set<string>>; // conversationId -> userIds
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  // Auth state
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('openchat_token'));
  const [currentUser, setCurrentUser] = useState<{ userId: string; email: string; name?: string } | null>(() => {
    const saved = localStorage.getItem('openchat_user');
    return saved ? JSON.parse(saved) : null;
  });

  // Data state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contacts, setContacts] = useState<User[]>([]);
  const [presence, setPresence] = useState<Map<string, { status: string; statusMessage?: string }>>(new Map());
  const [typingUsers, setTypingUsers] = useState<Map<string, Set<string>>>(new Map());

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

  const { isConnected, joinConversation, leaveConversation, sendMessage: socketSendMessage, updatePresence: socketUpdatePresence } = useChatSocket({
    token,
    onMessage: handleMessage,
    onTypingStart: handleTypingStart,
    onTypingStop: handleTypingStop,
    onPresenceUpdate: handlePresenceUpdate,
  });

  // Set API token when auth changes
  useEffect(() => {
    api.setToken(token);
  }, [token]);

  // Login with token
  const login = useCallback((newToken: string) => {
    // Decode JWT to get user info (basic decode, not verification)
    try {
      const payload = JSON.parse(atob(newToken.split('.')[1]));
      const user = { userId: payload.userId, email: payload.email };
      setCurrentUser(user);
      setToken(newToken);
      localStorage.setItem('openchat_token', newToken);
      localStorage.setItem('openchat_user', JSON.stringify(user));
    } catch (e) {
      console.error('Invalid token:', e);
    }
  }, []);

  // Dev login with email (creates user if needed)
  const devLogin = useCallback(async (email: string, name?: string) => {
    const result = await api.devLogin(email, name);
    const user = { userId: result.user.id, email: result.user.email, name: result.user.name };
    setCurrentUser(user);
    setToken(result.token);
    localStorage.setItem('openchat_token', result.token);
    localStorage.setItem('openchat_user', JSON.stringify(user));
  }, []);

  // SSO login - exchange Noos SSO token for session
  const ssoLogin = useCallback(async (ssoToken: string) => {
    const result = await api.ssoExchange(ssoToken);
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
    setToken(null);
    setCurrentUser(null);
    setConversations([]);
    setMessages([]);
    setContacts([]);
    localStorage.removeItem('openchat_token');
    localStorage.removeItem('openchat_user');
  }, []);

  // Load conversations
  const loadConversations = useCallback(async () => {
    try {
      const data = await api.getConversations();
      setConversations(data);
    } catch (e) {
      console.error('Failed to load conversations:', e);
    }
  }, []);

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
  const createConversation = useCallback(async (participantIds: string[], title?: string) => {
    const conv = await api.createConversation(participantIds, title);
    setConversations(prev => [conv, ...prev]);
    return conv;
  }, []);

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

  // Load contacts
  const loadContacts = useCallback(async () => {
    try {
      const data = await api.getContacts();
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
      setPresence(newPresence);
    } catch (e) {
      console.error('Failed to load contacts:', e);
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
    devLogin,
    ssoLogin,
    logout,
    isConnected,
    conversations,
    activeConversationId,
    setActiveConversation,
    createConversation,
    loadConversations,
    messages,
    sendMessage,
    loadMessages,
    contacts,
    loadContacts,
    presence,
    updatePresence,
    typingUsers,
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
