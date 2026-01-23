import { reportFetchError, reportHttpError } from './utils/clientLogger';

const API_BASE = '/api/chat';
const AUTH_BASE = '/api/auth';
const NOOS_URL = import.meta.env.VITE_NOOS_URL || 'http://localhost:52743';

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

  private getToken() {
    if (this.token) return this.token;
    try {
      const stored = localStorage.getItem('openchat_token');
      if (stored) {
        this.token = stored;
        return stored;
      }
    } catch {
      // localStorage may be unavailable in some environments.
    }
    return null;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const token = this.getToken();
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }

    const url = `${API_BASE}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
      });
    } catch (error) {
      reportFetchError({
        url,
        method: options.method || 'GET',
        error,
      });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({
        url,
        method: options.method || 'GET',
        status: response.status,
        statusText: response.statusText,
      });
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

  // Auth - Login via Noos
  async login(email: string, password: string): Promise<{ token: string; user: User; refreshToken?: string }> {
    const url = `${NOOS_URL}/api/auth/login`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({
        url,
        method: 'POST',
        status: response.status,
        statusText: response.statusText,
      });
      const error = await response.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(error.error || 'Login failed');
    }

    const data = await response.json();
    return {
      token: data.accessToken,
      user: data.user,
      refreshToken: data.refreshToken
    };
  }

  // Dev login (for development without password)
  async devLogin(email: string, name?: string): Promise<{ token: string; user: User; expiresIn: number }> {
    const url = `${AUTH_BASE}/dev-login`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({
        url,
        method: 'POST',
        status: response.status,
        statusText: response.statusText,
      });
      const error = await response.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(error.error || 'Login failed');
    }

    return response.json();
  }

  // Register via Noos
  async register(email: string, password: string, name: string): Promise<{ token: string; user: User }> {
    const url = `${NOOS_URL}/api/auth/register`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({
        url,
        method: 'POST',
        status: response.status,
        statusText: response.statusText,
      });
      const error = await response.json().catch(() => ({ error: 'Registration failed' }));
      throw new Error(error.error || 'Registration failed');
    }

    const data = await response.json();
    return {
      token: data.accessToken,
      user: data.user
    };
  }

  async getMe(): Promise<User> {
    return this.fetch('/me'.replace('/chat', '/auth'));
  }

  async logout(): Promise<void> {
    const url = `${AUTH_BASE}/logout`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }
  }

  // Exchange SSO code/token from Noos for full auth tokens
  async ssoExchange(payload: { code?: string; token?: string }): Promise<{ token: string; user: User }> {
    const url = `${NOOS_URL}/api/auth/sso-exchange`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({
        url,
        method: 'POST',
        status: response.status,
        statusText: response.statusText,
      });
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
