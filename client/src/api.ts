const API_BASE = '/api/chat';
const AUTH_BASE = '/api/auth';
const NOOS_URL = import.meta.env.VITE_NOOS_URL || 'http://localhost:4747';

export interface User {
  id: string;
  name: string;
  email: string;
  presenceStatus?: string;
  statusMessage?: string;
  lastSeenAt?: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  conversationId: string;
  messageType: string;
  createdAt: string;
  editedAt?: string;
  sender?: User;
}

export interface Conversation {
  id: string;
  title?: string;
  type: 'direct' | 'group';
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  lastMessage?: Message;
  participants?: { user: User; role: string }[];
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  }

  // Conversations
  async getConversations(): Promise<Conversation[]> {
    return this.fetch('/conversations');
  }

  async createConversation(participantIds: string[], title?: string, type: 'direct' | 'group' = 'direct'): Promise<Conversation> {
    return this.fetch('/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantIds, title, type }),
    });
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.fetch(`/conversations/${id}`);
  }

  // Messages
  async getMessages(conversationId: string, before?: string): Promise<Message[]> {
    const params = new URLSearchParams();
    if (before) params.set('before', before);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.fetch(`/conversations/${conversationId}/messages${query}`);
  }

  async sendMessage(conversationId: string, content: string): Promise<Message> {
    return this.fetch(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  // Contacts
  async getContacts(search?: string): Promise<User[]> {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.fetch(`/contacts${query}`);
  }

  // User lookup by email
  async getUserByEmail(email: string): Promise<User> {
    return this.fetch(`/users/by-email/${encodeURIComponent(email)}`);
  }

  // Presence
  async updatePresence(presenceStatus?: string, statusMessage?: string): Promise<User> {
    return this.fetch('/presence', {
      method: 'PUT',
      body: JSON.stringify({ presenceStatus, statusMessage }),
    });
  }

  // Auth
  async devLogin(email: string, name?: string): Promise<{ token: string; user: User; expiresIn: number }> {
    const response = await fetch(`${AUTH_BASE}/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(error.error || 'Login failed');
    }

    return response.json();
  }

  async getMe(): Promise<User> {
    return this.fetch('/me'.replace('/chat', '/auth'));
  }

  async logout(): Promise<void> {
    await fetch(`${AUTH_BASE}/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
  }

  // Exchange SSO token from Noos for full auth tokens
  async ssoExchange(ssoToken: string): Promise<{ token: string; user: User }> {
    const response = await fetch(`${NOOS_URL}/api/auth/sso-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ssoToken }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'SSO exchange failed' }));
      throw new Error(error.error || 'SSO exchange failed');
    }

    const data = await response.json();
    // Return in format compatible with our auth system
    return {
      token: data.accessToken,
      user: data.user
    };
  }
}

export const api = new ApiClient();
