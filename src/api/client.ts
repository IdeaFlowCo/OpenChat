/**
 * OpenChat API client for React Native.
 *
 * Mirrors the surface area of client/src/api.ts in the web client, but
 * adapted for React Native (no DOM, no localStorage — uses AsyncStorage,
 * and io() with explicit URL + transports).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// Production by default; can override via .env (EXPO_PUBLIC_OPENCHAT_URL).
export const OPENCHAT_URL =
  process.env.EXPO_PUBLIC_OPENCHAT_URL || 'https://chat.globalbr.ai';
export const NOOS_URL =
  process.env.EXPO_PUBLIC_NOOS_URL || 'https://globalbr.ai';

const TOKEN_KEY = 'openchat_token';
const USER_KEY = 'openchat_user';

export interface User {
  id: string;
  email: string;
  name?: string;
  presenceStatus?: string;
  statusMessage?: string;
  lastSeenAt?: string;
}

export interface Participant {
  user: User;
  role?: 'owner' | 'member';
}

export interface Conversation {
  id: string;
  title?: string | null;
  type: 'direct' | 'group';
  participants?: Participant[];
  lastMessagePreview?: string;
  lastMessageAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  conversationId: string;
  messageType?: string;
  createdAt: string;
  editedAt?: string;
  sender?: { id: string; name?: string; email: string };
}

export interface CurrentUser {
  userId: string;
  email: string;
  name?: string;
}

let memToken: string | null = null;
let memUser: CurrentUser | null = null;

export async function getToken(): Promise<string | null> {
  if (memToken !== null) return memToken;
  const t = await AsyncStorage.getItem(TOKEN_KEY);
  memToken = t;
  return t;
}

export async function getUser(): Promise<CurrentUser | null> {
  if (memUser) return memUser;
  const u = await AsyncStorage.getItem(USER_KEY);
  if (!u) return null;
  try {
    memUser = JSON.parse(u);
    return memUser;
  } catch {
    return null;
  }
}

export async function setSession(token: string, user: CurrentUser): Promise<void> {
  memToken = token;
  memUser = user;
  await AsyncStorage.multiSet([
    [TOKEN_KEY, token],
    [USER_KEY, JSON.stringify(user)],
  ]);
}

export async function clearSession(): Promise<void> {
  memToken = null;
  memUser = null;
  await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
}

async function request<T>(
  path: string,
  init?: RequestInit & { auth?: boolean }
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (init?.auth !== false) {
    const token = await getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${OPENCHAT_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error || j.message || text;
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  return (await res.json()) as T;
}

// Auth — uses Noos directly for now (mirrors what the web client does via SSO).
export async function loginWithPassword(
  email: string,
  password: string
): Promise<{ user: CurrentUser; token: string }> {
  const res = await fetch(`${NOOS_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error || j.message || text;
    } catch {
      /* not JSON */
    }
    throw new Error(`Login failed (${res.status}): ${msg}`);
  }
  const body = await res.json();
  const user: CurrentUser = {
    userId: body.user.id,
    email: body.user.email,
    name: body.user.name,
  };
  await setSession(body.accessToken, user);
  return { user, token: body.accessToken };
}

export const api = {
  getConversations: () => request<Conversation[]>('/api/chat/conversations'),
  getMessages: (conversationId: string) =>
    request<Message[]>(`/api/chat/conversations/${conversationId}/messages`),
  sendMessage: (conversationId: string, content: string) =>
    request<Message>(`/api/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  getContacts: (q?: string) =>
    request<User[]>(`/api/chat/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createConversation: (participantIds: string[], title?: string, type: 'direct' | 'group' = 'direct') =>
    request<Conversation>('/api/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantIds, title, type }),
    }),
};
