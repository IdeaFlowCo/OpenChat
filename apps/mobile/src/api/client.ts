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

/** Aggregated reaction summary for one plain or semantic reaction bucket. */
export interface ReactionSummary {
  emoji: string;
  count: number;
  byMe: boolean;
  /**
   * Semantic kind tag (openchat-reaction-kind). Plain reactions omit this.
   * 'filed' = a bot's filed-receipt whose `href` links to the KB page it
   * created; clients render kind reactions as a tappable link.
   */
  kind?: string | null;
  /** Target URL for a kind reaction (e.g. the filed KB page). */
  href?: string | null;
}

/** Open Graph / Twitter card preview data (OpenChat-hq2). */
export interface LinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
  fetchedAt: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  conversationId: string;
  messageType?: string;
  /** Structured system card metadata. cardPayload is JSON encoded by the server. */
  cardKind?: string;
  cardPayload?: string;
  createdAt: string;
  editedAt?: string;
  /** Set when the message has been soft-deleted. */
  deletedAt?: string;
  sender?: { id: string; name?: string; email: string };
  /** ID of the message this message is replying to (OpenChat-uxj).
   *  Server support is a follow-up ticket; field is passed through on send
   *  and stored locally on optimistic messages. */
  replyToId?: string;
  /** Embedded snapshot of the quoted message for rendering the reply header. */
  replyTo?: {
    id: string;
    content: string;
    senderId: string;
    sender?: { id: string; name?: string; email: string };
  };
  /** Aggregated reactions, including optional semantic kind receipts. */
  reactions?: ReactionSummary[];
  /** Image attachments (OpenChat-6bg). */
  attachments?: Attachment[];
  /** User IDs mentioned in this message via @-mentions (OpenChat-0jy). */
  mentions?: string[];
  /** Open Graph link preview cards (OpenChat-hq2). */
  linkPreviews?: LinkPreview[];
  /** Forwarding fields (OpenChat-hhc). Set when this message was forwarded. */
  forwardedFromMessageId?: string;
  forwardedFromSenderId?: string;
  /** Display-name snapshot of the original sender at forward time. */
  forwardedFromSenderName?: string;
  /** Auto-generated transcript of a voice message (OpenChat-4jn).
   *  Present on history load, and updated live via the `message:transcript`
   *  socket event. */
  transcript?: string;
  /** Owner-approved automatic reply sent by personal Secretary mode. */
  viaSecretary?: boolean;
}

export type AgentIntentKind = 'ask' | 'offer';
export type AgentIntentStatus = 'active' | 'withdrawn' | 'connected';
export type AgentMatchStatus = 'pending' | 'awaiting_other' | 'closed' | 'connected';

export interface AgentIntent {
  id: string;
  ownerUserId: string;
  kind: AgentIntentKind;
  terms: string;
  details: string | null;
  status: AgentIntentStatus;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Privacy-safe, per-viewer match projection returned by the REST API. */
export interface AgentMatch {
  id: string;
  status: AgentMatchStatus;
  ownIntent: Pick<AgentIntent, 'id' | 'kind' | 'terms'>;
  otherKind: AgentIntentKind;
  otherTerms: string;
  createdAt: string;
  updatedAt: string;
  conversationId?: string;
  alreadyResolved?: boolean;
}

export interface SecretaryAnswer {
  id: string;
  question: string;
  answer: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SecretaryConfig {
  enabled: boolean;
  answers: SecretaryAnswer[];
}

/** Single attachment — image or audio (OpenChat-6bg, OpenChat-xxc). */
export interface Attachment {
  url: string;
  mimeType: string;
  /** For image attachments. */
  width?: number;
  height?: number;
  /** For audio attachments (OpenChat-xxc). */
  type?: 'audio';
  durationMs?: number;
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
 * Public Google OAuth client IDs (PROD). Safe to commit — these are public.
 *
 * GOOGLE_CLIENT_ID is the Web client (used by chat.globalbr.ai). NOT used on
 *   iOS — Google rejects custom-scheme redirect URIs on Web-type clients.
 * GOOGLE_IOS_CLIENT_ID is the iOS-type client created 2026-05-31. Bundle ID
 *   com.jacobcole.openchat. No client secret (PKCE). This is what
 *   expo-auth-session uses for the iOS sign-in flow.
 *
 * Override at build time via EXPO_PUBLIC_* env vars for dev / staging.
 */
export const GOOGLE_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
  '874749606899-f2epm744j73anm2dnf59j6igehhlku0a.apps.googleusercontent.com';

export const GOOGLE_IOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ||
  '874749606899-ajd7segoct156poo3gbeoefg3s349626.apps.googleusercontent.com';

/**
 * GOOGLE_ANDROID_CLIENT_ID — the Android-type OAuth client (package
 * com.jacobcole.openchat + the signing-cert SHA-1). REQUIRED for native
 * Android Google sign-in: Android rejects iOS/Web client IDs, so the OAuth
 * flow can't return to the app and strands the user on Google's homepage
 * (→ news). Create the client in the GCP console (Credentials → OAuth client →
 * Android) and set EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID. Until then it falls
 * back to the iOS client so builds don't break — but Android sign-in stays
 * broken until the real Android client is configured. (openchat — android-oauth)
 */
export const GOOGLE_ANDROID_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || GOOGLE_IOS_CLIENT_ID;

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

/**
 * Exchange a Google ID token for an OpenChat JWT + user. This is the iOS
 * native path — expo-auth-session/providers/google with the iOS clientId
 * returns the ID token directly (PKCE, no secret). We POST it to the
 * dedicated server endpoint which verifies against Google's certs and
 * MERGEs the user by email (same User node as the web flow lands on).
 */
export async function googleIdTokenExchange(
  idToken: string
): Promise<{ user: CurrentUser; token: string }> {
  const res = await fetch(`${OPENCHAT_URL}/api/auth/google/idtoken-exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
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

/**
 * Exchange an Apple identity token for an OpenChat JWT + user. (OpenChat-c08)
 * iOS-only — expo-apple-authentication returns the identityToken after the
 * native SIWA sheet completes. We POST it to the server which verifies against
 * Apple's JWKS and MERGEs the User by email (or appleSub for Hide My Email).
 */
export async function signInWithApple(
  identityToken: string,
  fullName: { givenName?: string | null; familyName?: string | null } | null,
  email: string | null
): Promise<{ user: CurrentUser; token: string }> {
  const res = await fetch(`${OPENCHAT_URL}/api/auth/apple/idtoken-exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identityToken, fullName, email }),
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
    throw new Error(`Apple sign-in failed (${res.status}): ${msg}`);
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
 * Create a new account with email + password + name (Noos /api/auth/register),
 * then sign in. Gives users a path that doesn't depend on Google/Apple — needed
 * especially on Android where native Google sign-in requires extra setup.
 */
export async function registerWithPassword(
  email: string,
  password: string,
  name: string
): Promise<{ user: CurrentUser; token: string }> {
  const res = await fetch(`${NOOS_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
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
    throw new Error(`Sign-up failed (${res.status}): ${msg}`);
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

// ── Thoughts (OpenChat-zi1) ───────────────────────────────────────────────────

export type ThoughtKind = 'fact' | 'decision' | 'commitment' | 'reminder' | 'observation';
export type ThoughtStatus = 'none' | 'open' | 'closed';

export interface Thought {
  id: string;
  text: string;
  kind: ThoughtKind;
  status: ThoughtStatus;
  createdAt: string;
  updatedAt: string;
  /** Tags extracted from the thought (e.g. hashtags). Rendered as chips. */
  tags?: string[];
  /** Provenance: the chat this thought was captured from, if any. */
  sourceConversationId?: string | null;
  sourceConversationName?: string | null;
  /** Pin state (chat-scoped views). */
  pinned?: boolean;
  pinnedBy?: string | null;
  pinnedAt?: string | null;
  /** Author info — present on pinned thoughts from other participants. */
  authorId?: string | null;
  authorName?: string | null;
}

/** Chat-scoped thoughts payload (GET /api/thoughts/conversation/:id). */
export interface ConversationThoughts {
  /** Pinned to this conversation, any participant. */
  pinned: Thought[];
  /** The caller's own thoughts captured from this chat (not pinned). */
  fromChat: Thought[];
}

// ── Agent key types (OpenChat-7c9) ────────────────────────────────────────────

export interface AgentKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  agentName?: string | null;
  agentVersion?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

/** Returned from createAgentKey — includes the full plaintext key. */
export interface AgentKeyCreateResult {
  id: string;
  name: string;
  keyPrefix: string;
  key: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string | null;
}

export type ExportRangeKey = 'last_hour' | 'last_day' | 'last_week' | 'last_month' | 'all_time';

export const EXPORT_RANGE_OPTIONS: Array<{ key: ExportRangeKey; label: string; detail: string }> = [
  { key: 'last_hour', label: 'Last hour', detail: 'The latest messages and activity' },
  { key: 'last_day', label: 'Last day', detail: 'Everything from the past 24 hours' },
  { key: 'last_week', label: 'Last week', detail: 'The past 7 days' },
  { key: 'last_month', label: 'Last month', detail: 'The past 30 days' },
  { key: 'all_time', label: 'All time', detail: 'Your full available history' },
];

export interface JsonDownload {
  filename: string;
  text: string;
}

function filenameFromDisposition(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/filename="([^"]+)"/i) || value.match(/filename=([^;]+)/i);
  return match?.[1]?.trim() || fallback;
}

async function requestJsonDownload(path: string, fallbackFilename: string): Promise<JsonDownload> {
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${OPENCHAT_URL}${path}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error || j.message || text;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || res.status === 403) emitAuthExpired();
    throw new ApiError(res.status, `${res.status}: ${msg}`, text);
  }
  return {
    filename: filenameFromDisposition(res.headers.get('content-disposition'), fallbackFilename),
    text,
  };
}

export const api = {
  getConversations: () => request<Conversation[]>('/api/chat/conversations'),
  getConversation: (conversationId: string) =>
    request<Conversation>(`/api/chat/conversations/${conversationId}`),
  getMessages: (conversationId: string) =>
    request<{ messages: Message[]; hasMore: boolean }>(`/api/chat/conversations/${conversationId}/messages`),
  getMessagesBefore: (conversationId: string, before: string, limit = 50) =>
    request<{ messages: Message[]; hasMore: boolean }>(
      `/api/chat/conversations/${conversationId}/messages?before=${encodeURIComponent(before)}&limit=${limit}`
    ),
  sendMessage: (conversationId: string, content: string, attachments?: Attachment[], id?: string) =>
    request<Message>(`/api/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      // id: client-generated idempotency key shared with the socket path so a
      // WS-then-REST retry collapses to one row server-side (MERGE). OpenChat-60y.
      body: JSON.stringify({ content, ...(attachments?.length ? { attachments } : {}), ...(id ? { id } : {}) }),
    }),

  // ── Agent-network asks, offers, and quiet matches ───────────────────────
  publishIntent: (params: { kind: AgentIntentKind; terms: string; details?: string; expiresAt?: string }) =>
    request<{ intent: AgentIntent }>('/api/intents', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  listIntents: async () => (await request<{ intents: AgentIntent[] }>('/api/intents')).intents,
  withdrawIntent: (id: string) =>
    request<{ intent: AgentIntent }>(`/api/intents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'withdrawn' }),
    }),
  listMatches: async () => (await request<{ matches: AgentMatch[] }>('/api/matches')).matches,
  respondToMatch: async (id: string, decision: 'approve' | 'decline') =>
    (await request<{ match: AgentMatch }>(`/api/matches/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })).match,
  /** Idempotently create or return the caller's private My Agent conversation. */
  ensureAssistant: () =>
    request<Conversation>('/api/assistant/ensure', { method: 'POST' }),

  /**
   * Request a presigned PUT URL for an image upload. (OpenChat-6bg)
   * Returns { putUrl, getUrl, key } — putUrl is the presigned GCS URL,
   * getUrl is the public-read download URL to store on the message.
   */
  presignAttachment: (params: { filename: string; mimeType: string; sizeBytes: number }) =>
    request<{ putUrl: string; getUrl: string; key: string }>('/api/chat/attachments/presign', {
      method: 'POST',
      body: JSON.stringify(params),
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
   * Register the Expo native push token for this device. Server upserts a
   * NativePushToken keyed by (userId, platform). Returns 204. (OpenChat-vg7)
   * Bypasses request<T>() because the response has no body.
   */
  registerNativePushToken: async (token: string, platform: 'ios' | 'android') => {
    const t = await getToken();
    const r = await fetch(`${OPENCHAT_URL}/api/push/register-native`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(t ? { authorization: `Bearer ${t}` } : {}),
      },
      body: JSON.stringify({ token, platform }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new ApiError(r.status, `${r.status}: ${text}`, text);
    }
  },

  /** Deregister the Expo native push token for this device at logout. */
  deregisterNativePushToken: async (platform: 'ios' | 'android') => {
    const t = await getToken();
    const r = await fetch(`${OPENCHAT_URL}/api/push/register-native`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        ...(t ? { authorization: `Bearer ${t}` } : {}),
      },
      body: JSON.stringify({ platform }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new ApiError(r.status, `${r.status}: ${text}`, text);
    }
  },

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

  /**
   * Delete the authenticated user's account. Server replaces sent messages with
   * "Message deleted" and removes the User node. (OpenChat-nhy)
   */
  deleteAccount: () =>
    request<{ ok: boolean }>('/api/auth/me', { method: 'DELETE' }),

  /**
   * Submit user feedback. Server creates a WorldIssueTracker issue (oc8.3) and
   * returns its URL. Requires the server /api/feedback route (gated on the
   * WIT_AGENT_KEY env var); returns 503 until that's configured/deployed.
   */
  submitFeedback: (message: string, context?: string) =>
    request<{ url: string; id?: string }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ message, context }),
    }),

  /**
   * Check whether the current user has accepted the AI disclosure. (OpenChat-ds3)
   * Returns `{ acceptedAt: string | null }`.
   */
  getAiDisclosureStatus: () =>
    request<{ acceptedAt: string | null }>('/api/chat/ai-disclosure-status'),

  /**
   * Record acceptance of the AI disclosure. (OpenChat-ds3)
   * Returns `{ acceptedAt: string }`.
   */
  acceptAiDisclosure: () =>
    request<{ acceptedAt: string }>('/api/chat/ai-disclosure-accept', { method: 'POST' }),

  // ── Block / unblock / list (OpenChat-46p) ───────────────────────────────

  /**
   * Block a user by their userId. Conversation with that user will be removed
   * from the caller's conversation list server-side.
   * POST /api/chat/users/:id/block
   */
  blockUser: (userId: string) =>
    request<{ ok: boolean }>(`/api/chat/users/${userId}/block`, { method: 'POST' }),

  /**
   * Unblock a previously blocked user.
   * DELETE /api/chat/users/:id/block
   */
  unblockUser: (userId: string) =>
    request<{ ok: boolean }>(`/api/chat/users/${userId}/block`, { method: 'DELETE' }),

  /**
   * List all users blocked by the current user.
   * GET /api/chat/blocks → User[]
   */
  listBlocked: () =>
    request<User[]>('/api/chat/blocks'),

  // ── Edit / Delete messages (OpenChat-q9h) ───────────────────────────────────

  /**
   * Edit own message. Owner-only. Sets editedAt on the message.
   * PATCH /api/chat/messages/:id
   */
  editMessage: (messageId: string, content: string) =>
    request<Message>(`/api/chat/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),

  /**
   * Soft-delete own message. Replaces content with "Message deleted".
   * DELETE /api/chat/messages/:id
   */
  deleteMessage: (messageId: string) =>
    request<Message>(`/api/chat/messages/${messageId}`, { method: 'DELETE' }),

  // ── Reactions (OpenChat-7bd) ─────────────────────────────────────────────────

  /**
   * Add a reaction to a message (idempotent — re-adding same emoji is no-op).
   * POST /api/chat/messages/:id/reactions
   */
  addReaction: (messageId: string, emoji: string) =>
    request<{ reactions: ReactionSummary[] }>(`/api/chat/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }),

  /**
   * Remove own reaction from a message.
   * DELETE /api/chat/messages/:id/reactions/:emoji
   */
  removeReaction: (messageId: string, emoji: string) =>
    request<{ reactions: ReactionSummary[] }>(
      `/api/chat/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' }
    ),

  // ── Read receipts (OpenChat-0nj) ────────────────────────────────────────

  /**
   * Mark the conversation as read by the current user. Returns `lastReadAt`
   * plus per-participant `readMap` and `onlineMap`.
   * PATCH /api/chat/conversations/:id/read
   */
  markRead: (conversationId: string) =>
    request<{
      ok: boolean;
      lastReadAt: string;
      readMap: Record<string, string | null>;
      onlineMap: Record<string, boolean>;
    }>(`/api/chat/conversations/${conversationId}/read`, { method: 'PATCH' }),

  // ── Mute / unmute conversation (OpenChat-aes) ───────────────────────────
  /**
   * Set this user's mute state on a conversation. mutedUntil is one of:
   *   - null       → unmute
   *   - 'always'   → mute indefinitely
   *   - Date       → mute until that point in time
   * Server persists on the PARTICIPATES_IN edge and respects it during
   * push-notification fanout (mentioned users break through mute).
   * PATCH /api/chat/conversations/:id/participants/me
   */
  setConversationMute: (conversationId: string, mutedUntil: Date | 'always' | null) => {
    const body =
      mutedUntil === null   ? { mutedUntil: null }
    : mutedUntil === 'always' ? { mutedUntil: 'always' as const }
    :                          { mutedUntil: mutedUntil.toISOString() };
    return request<{ conversationId: string; mutedUntil: string | null }>(
      `/api/chat/conversations/${conversationId}/participants/me`,
      { method: 'PATCH', body: JSON.stringify(body) }
    );
  },

  // ── Profile editing (OpenChat-tml) ──────────────────────────────────────

  /**
   * Update the current user's display name and/or status message.
   * PATCH /api/auth/me
   */
  updateProfile: (fields: {
    name?: string;
    statusMessage?: string;
    avatarUrl?: string;
    onboardingComplete?: boolean;
  }) =>
    request<{
      id: string;
      email: string;
      name?: string;
      statusMessage?: string;
      avatarUrl?: string;
      onboardedAt?: string;
    }>('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(fields),
    }),

  // ── Personal Secretary (OpenChat-3kr.3.1) ───────────────────────────────
  getSecretary: () => request<SecretaryConfig>('/api/secretary'),
  setSecretaryEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>('/api/secretary', {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  createSecretaryAnswer: (fields: { question: string; answer: string }) =>
    request<SecretaryAnswer>('/api/secretary/answers', {
      method: 'POST',
      body: JSON.stringify(fields),
    }),
  updateSecretaryAnswer: (id: string, fields: { question: string; answer: string }) =>
    request<SecretaryAnswer>(`/api/secretary/answers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    }),
  deleteSecretaryAnswer: (id: string) =>
    request<{ ok: boolean }>(`/api/secretary/answers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Request a presigned PUT URL for an avatar image upload (OpenChat-x2s).
   * Reuses the same attachments/presign endpoint but is called from onboarding.
   * Returns { putUrl, getUrl, key }.
   */
  presignAvatar: (params: { filename: string; mimeType: string; sizeBytes: number }) =>
    request<{ putUrl: string; getUrl: string; key: string }>('/api/chat/attachments/presign', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // ── Report message / user (OpenChat-wgl) ────────────────────────────────

  /**
   * Submit a report for a message or user.
   * POST /api/chat/reports
   * Body: { targetType, targetId, reason, freeform? }
   */
  submitReport: (params: {
    targetType: 'message' | 'user';
    targetId: string;
    reason: string;
    freeform?: string;
  }) =>
    request<{ ok: boolean }>('/api/chat/reports', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // ── Reconnect catch-up (OpenChat-qz0) ───────────────────────────────────

  /**
   * Fetch all messages newer than `since` across every conversation the
   * current user participates in. Called on socket reconnect to recover
   * messages missed during a disconnect window.
   *
   * GET /api/chat/messages/since?since=<ISO>
   *
   * Returns `{ messages, truncated }`. When `truncated` is true, more than
   * 500 messages arrived during the gap — the caller should fall back to a
   * full `refreshConversations()` instead of trying to merge.
   */
  messagesSince: (since: string) =>
    request<{ messages: Message[]; truncated: boolean }>(
      `/api/chat/messages/since?since=${encodeURIComponent(since)}`
    ),

  // ── Group invite endpoints (OpenChat-240) ─────────────────────────────────

  /**
   * Create (or return active) invite for a group conversation. Owner-only.
   * POST /api/chat/conversations/:id/invites
   * Returns { token, url, expiresAt, usesLeft }.
   */
  createInvite: (
    conversationId: string,
    opts?: { expiresInDays?: number; maxUses?: number }
  ) =>
    request<{ token: string; url: string; expiresAt: string; usesLeft: number }>(
      `/api/chat/conversations/${conversationId}/invites`,
      {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }
    ),

  /**
   * Get invite preview — any authed user. No participant PII.
   * GET /api/chat/invites/:token
   * Returns { conversationId, conversationTitle, memberCount, expiresAt }.
   */
  getInvitePreview: (token: string) =>
    request<{
      conversationId: string;
      conversationTitle: string | null;
      memberCount: number;
      expiresAt: string;
    }>(`/api/chat/invites/${token}`),

  /**
   * Accept/join via invite token. Idempotent if already a member.
   * POST /api/chat/invites/:token/accept
   * Returns { conversationId, conversation }.
   */
  acceptInvite: (token: string) =>
    request<{ conversationId: string; conversation: Conversation }>(
      `/api/chat/invites/${token}/accept`,
      { method: 'POST' }
    ),

  /**
   * Revoke an invite. Owner-only.
   * DELETE /api/chat/conversations/:id/invites/:token
   */
  revokeInvite: (conversationId: string, token: string) =>
    request<{ ok: boolean }>(
      `/api/chat/conversations/${conversationId}/invites/${token}`,
      { method: 'DELETE' }
    ),

  // ── Message forwarding (OpenChat-hhc) ─────────────────────────────────────

  /**
   * Forward a message to another conversation. The server creates a new
   * Message in the target conversation with forwardedFrom* fields set.
   * POST /api/chat/messages/:id/forward
   */
  forwardMessage: (messageId: string, toConversationId: string) =>
    request<Message>(`/api/chat/messages/${messageId}/forward`, {
      method: 'POST',
      body: JSON.stringify({ toConversationId }),
    }),

  /**
   * Forward a message to the current user's PRIVATE Assistant DM (openchat-ug6).
   *
   * Unlike forwardMessage (which posts into a shared conversation the user
   * picks), this is private — the server drops the quoted message into the
   * caller's own Assistant conversation and, when a `question` is supplied,
   * asks the assistant about it. Nothing is posted into the shared/source
   * conversation.
   *
   * POST /api/assistant/forward
   *   body: { sourceConversationId, sourceMessageId, question? }
   *   -> { conversationId }   // the user's Assistant DM to navigate to
   *
   * Server-side endpoint is being built in parallel; we code to this contract.
   */
  forwardToAssistant: (params: {
    sourceConversationId: string;
    sourceMessageId: string;
    question?: string;
  }) =>
    request<{ conversationId: string }>('/api/assistant/forward', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // ── Thoughts (OpenChat-zi1) ────────────────────────────────────────────────

  /**
   * List my thoughts, newest first. When `q` is provided the server matches
   * against thought text OR any tag (case-insensitive). Composable with
   * `before` pagination.
   */
  getThoughts: (opts?: { limit?: number; before?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.before) qs.set('before', opts.before);
    if (opts?.q) qs.set('q', opts.q);
    const q = qs.toString();
    return request<Thought[]>(`/api/thoughts${q ? `?${q}` : ''}`);
  },

  /**
   * Create a new thought. `sourceMessageId` records save-to-thoughts
   * provenance from a chat message; `pinToConversationId` additionally pins
   * the new thought to that conversation ("Save & pin").
   */
  createThought: (body: {
    text: string;
    kind?: ThoughtKind;
    status?: ThoughtStatus;
    sourceMessageId?: string;
    pinToConversationId?: string;
  }) =>
    request<Thought>('/api/thoughts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Chat-scoped thoughts: pinned to + captured from one conversation. */
  getConversationThoughts: (conversationId: string) =>
    request<ConversationThoughts>(`/api/thoughts/conversation/${encodeURIComponent(conversationId)}`),

  /** Pin one of my thoughts to a conversation I participate in. */
  pinThought: (id: string, conversationId: string) =>
    request<Thought>(`/api/thoughts/${encodeURIComponent(id)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ conversationId }),
    }),

  /** Unpin a thought from a conversation (owner or pinner only). */
  unpinThought: async (id: string, conversationId: string): Promise<void> => {
    const token = await getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(
      `${OPENCHAT_URL}/api/thoughts/${encodeURIComponent(id)}/pin/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE', headers }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `${res.status}: ${text}`, text);
    }
  },

  /** Update an existing thought. */
  updateThought: (
    id: string,
    fields: { text?: string; kind?: ThoughtKind; status?: ThoughtStatus }
  ) =>
    request<Thought>(`/api/thoughts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    }),

  /** Delete a thought (204 response → returns void). */
  deleteThought: async (id: string): Promise<void> => {
    const token = await getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${OPENCHAT_URL}/api/thoughts/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `${res.status}: ${text}`, text);
    }
  },

  // ── Agent API keys (OpenChat-7c9) ────────────────────────────────────────

  /** List the caller's agent keys (no plaintext). */
  listAgentKeys: () => request<AgentKey[]>('/api/agent-keys'),

  /**
   * Create a new agent key. Returns the full plaintext key once.
   * (Re-viewable via revealAgentKey after creation.)
   */
  createAgentKey: (params: {
    name: string;
    scopes?: string[];
    agentName?: string;
    expiresAt?: string;
  }) =>
    request<AgentKeyCreateResult>('/api/agent-keys', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  /** Reveal the full plaintext key (writes audit log). */
  revealAgentKey: (id: string) =>
    request<{ id: string; name: string; key: string }>(`/api/agent-keys/${id}/reveal`),

  /** Revoke an agent key immediately. */
  revokeAgentKey: (id: string) =>
    request<{ ok: boolean }>(`/api/agent-keys/${id}`, { method: 'DELETE' }),

  // ── Data export (OpenChat export UX) ─────────────────────────────────────

  exportConversation: (conversationId: string, range: ExportRangeKey) =>
    requestJsonDownload(
      `/api/chat/conversations/${conversationId}/export?range=${encodeURIComponent(range)}`,
      `openchat-conversation-${range}.json`
    ),

  exportAccount: (range: ExportRangeKey) =>
    requestJsonDownload(
      `/api/auth/export?range=${encodeURIComponent(range)}`,
      `openchat-account-${range}.json`
    ),
};
