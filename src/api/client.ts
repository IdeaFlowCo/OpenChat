/**
 * OpenChat API client for React Native.
 *
 * Mirrors the surface area of client/src/api.ts in the web client, but
 * adapted for React Native (no DOM, no localStorage — uses AsyncStorage,
 * and io() with explicit URL + transports).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Token storage strategy (OpenChat-ghr):
 *  - The JWT lives in SecureStore (iOS Keychain / Android Keystore) so it
 *    survives app uninstall reasonably AND is encrypted at rest.
 *  - The User profile cache still lives in AsyncStorage — it's not a secret
 *    and we want it readable from non-async code paths.
 *
 * Migration: on first read after upgrade, if the JWT is in AsyncStorage but
 * NOT in SecureStore, copy it over and delete the old key. Idempotent.
 */
const SECURE_TOKEN_KEY = 'openchat_jwt_v1';

async function getTokenFromAnywhere(): Promise<string | null> {
  // Prefer SecureStore.
  try {
    const t = await SecureStore.getItemAsync(SECURE_TOKEN_KEY);
    if (t) return t;
  } catch {
    // SecureStore can fail on emulators that lack the keychain — fall through.
  }
  // Migration: legacy AsyncStorage token.
  try {
    const legacy = await AsyncStorage.getItem(TOKEN_KEY);
    if (legacy) {
      try {
        await SecureStore.setItemAsync(SECURE_TOKEN_KEY, legacy);
        await AsyncStorage.removeItem(TOKEN_KEY);
      } catch {
        // If we can't promote to SecureStore, keep using AsyncStorage so the
        // user doesn't get logged out on a device where SecureStore is broken.
      }
      return legacy;
    }
  } catch {
    /* unreadable storage */
  }
  return null;
}

async function setTokenSecurely(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(SECURE_TOKEN_KEY, token);
    // Defensive: nuke any lingering legacy copy.
    try { await AsyncStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  } catch {
    // SecureStore failure — fall back to AsyncStorage so login still works.
    try { await AsyncStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  }
}

async function clearTokenEverywhere(): Promise<void> {
  try { await SecureStore.deleteItemAsync(SECURE_TOKEN_KEY); } catch { /* ignore */ }
  try { await AsyncStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

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
  avatarUrl?: string;
  /** True for AI / agent users (picortex, future agents). Surface as a badge. */
  isBot?: boolean;
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
  const t = await getTokenFromAnywhere();
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
  await setTokenSecurely(token);
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function clearSession(): Promise<void> {
  memToken = null;
  memUser = null;
  await clearTokenEverywhere();
  try { await AsyncStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}

/** Custom error class so callers / UI can branch on status without parsing. */
export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'ApiError';
  }
}

// Listener for global auth expiry. ChatProvider hooks this on mount so a
// 401 from any API call cascades into a clean sign-out + return to Login.
type AuthListener = () => void;
const authExpiredListeners: AuthListener[] = [];
export function onAuthExpired(fn: AuthListener): () => void {
  authExpiredListeners.push(fn);
  return () => {
    const i = authExpiredListeners.indexOf(fn);
    if (i >= 0) authExpiredListeners.splice(i, 1);
  };
}
function emitAuthExpired() {
  for (const fn of authExpiredListeners) {
    try { fn(); } catch { /* ignore listener errors */ }
  }
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
    if (res.status === 401 || res.status === 403) {
      // Token is invalid / expired. Cascade to sign-out so the user isn't
      // stuck on a stale screen with no recovery. Caller still gets a typed
      // error (which it usually shouldn't try to display since the listener
      // already navigated us to Login).
      emitAuthExpired();
    }
    throw new ApiError(res.status, `${res.status}: ${msg}`, text);
  }
  return (await res.json()) as T;
}

/**
 * Public Google OAuth client ID (PROD). Safe to commit — this is the same
 * client the web app uses for "Continue with Google" at chat.globalbr.ai. The
 * client SECRET stays server-side and is only used by the /api/auth/google/exchange
 * route. Native iOS uses this client (with `com.jacobcole.openchat:/oauth2redirect`
 * registered as an authorized redirect URI on the GCP OAuth client).
 *
 * Override at build time via EXPO_PUBLIC_GOOGLE_CLIENT_ID for dev / staging.
 */
export const GOOGLE_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
  '874749606899-f2epm744j73anm2dnf59j6igehhlku0a.apps.googleusercontent.com';

/**
 * Exchange a Google authorization code for an OpenChat JWT + user. Hits the
 * SAME server endpoint the web client uses (`POST /api/auth/google/exchange`).
 * The server holds GOOGLE_CLIENT_SECRET and performs the actual token swap
 * with Google, then mints an OpenChat JWT.
 *
 * On success the session is persisted via setSession() — identical to the
 * loginWithPassword side-effect — so callers can then invoke
 * ChatProvider.bootstrapIfAuthed() to flip the navigator into the authed stack.
 */
export async function googleExchange(
  code: string,
  redirectUri: string
): Promise<{ user: CurrentUser; token: string }> {
  const res = await fetch(`${OPENCHAT_URL}/api/auth/google/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, redirectUri }),
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
    throw new Error(`Google sign-in failed (${res.status}): ${msg}`);
  }
  const body = await res.json();
  const user: CurrentUser = {
    userId: body.user.id,
    email: body.user.email,
    name: body.user.name,
  };
  await setSession(body.token, user);
  return { user, token: body.token };
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

/**
 * Search response shape — mirrors server/src/routes/chat.ts → GET /search.
 * Three buckets returned together so the UI can render one combined search
 * panel without three separate round-trips.
 */
export interface SearchMessageHit {
  id: string;
  content: string;
  conversationId: string;
  senderId: string;
  createdAt: string;
  sender?: { id: string; name?: string; email: string; isBot?: boolean };
  conversationTitle?: string | null;
  conversationType?: 'direct' | 'group';
}

export interface SearchConversationHit {
  id: string;
  title?: string | null;
  type: 'direct' | 'group';
  lastMessageAt?: string;
  lastMessagePreview?: string;
  participants?: Array<{ id: string; name?: string; email: string; isBot?: boolean }>;
}

export interface SearchResults {
  messages: SearchMessageHit[];
  conversations: SearchConversationHit[];
  contacts: User[];
}

export const api = {
  getConversations: () => request<Conversation[]>('/api/chat/conversations'),
  getConversation: (conversationId: string) =>
    request<Conversation>(`/api/chat/conversations/${conversationId}`),
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
  renameConversation: (conversationId: string, title: string) =>
    request<Conversation>(`/api/chat/conversations/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  addParticipant: (conversationId: string, userId: string) =>
    request<Conversation>(`/api/chat/conversations/${conversationId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  removeParticipant: (conversationId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/chat/conversations/${conversationId}/participants/${userId}`, {
      method: 'DELETE',
    }),
  /**
   * Combined search across messages, conversations, and contacts. Server
   * filters by the caller's participant access — no leaks. `q` must be at
   * least 2 chars (server returns empty buckets for shorter queries).
   */
  search: (params: {
    q: string;
    scope?: 'global' | 'conversation';
    conversationId?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams({ q: params.q });
    if (params.scope) qs.set('scope', params.scope);
    if (params.conversationId) qs.set('conversationId', params.conversationId);
    if (params.limit) qs.set('limit', String(params.limit));
    return request<SearchResults>(`/api/chat/search?${qs.toString()}`);
  },
};
