import { reportFetchError, reportHttpError } from './utils/clientLogger';

const API_BASE = '/api/chat';
const AUTH_BASE = '/api/auth';
const NOOS_URL = import.meta.env.VITE_NOOS_URL || 'https://globalbr.ai';

// Storage keys are centralized to keep clearAuth() and any future migrations
// honest. If you add a new openchat_* key, add it here too. See OpenChat-2zr.
const TOKEN_KEY = 'openchat_token';
const REFRESH_TOKEN_KEY = 'openchat_refresh_token';
const USER_KEY = 'openchat_user';

// Window CustomEvent names. Consumed by ChatContext to keep React state in
// sync with the auth layer. (api.ts can't depend on React/Router, hence the
// event-bus dodge — codex review 2026-05-30 noted this is the pragmatic
// boundary and acceptable as long as we use narrow, typed events.)
//
// Detail shapes:
//   noos:token-refreshed  → { token: string }
//   noos:auth-expired     → {}
export const AUTH_EVENT_TOKEN_REFRESHED = 'noos:token-refreshed';
export const AUTH_EVENT_AUTH_EXPIRED = 'noos:auth-expired';

// Hard ceiling on consecutive refreshes between any two successful API
// calls. See `consecutiveRefreshes` field docs in ApiClient. Reaching the
// limit means refresh is "succeeding" against Noos but every refreshed
// token still gets rejected downstream — usually a config bug, not
// something a user can fix from the client, so we stop churning and force
// a clean logout.
const REFRESH_LOOP_LIMIT = 3;

export interface User {
  id: string;
  name: string;
  email: string;
  presenceStatus?: string;
  statusMessage?: string;
  lastSeenAt?: string;
  avatarUrl?: string;
  /**
   * True for AI/agent users (picortex, future agents). Surface as a badge in
   * the contact picker, conversation header, and message author so humans
   * can tell who they're talking to. OpenChat-aoy / agent-chat vision.
   */
  isBot?: boolean;
}

/** Single image attachment on a message (OpenChat-6bg). */
export interface Attachment {
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** Aggregated reaction for a message (openchat-bmp.1). */
export interface Reaction {
  emoji: string;
  count: number;
  byMe: boolean;
}

/**
 * Lightweight quoted target rendered as a reply preview (openchat-bmp.2).
 * Hydrated server-side on the message read + send paths (OpenChat-uxj).
 */
export interface ReplyTo {
  id: string;
  content: string;
  senderId: string;
  sender?: { id: string; name?: string; email?: string };
  senderName?: string;
  messageType?: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  conversationId: string;
  messageType: string;
  createdAt: string;
  editedAt?: string;
  /** Soft-delete marker (server sets content to "Message deleted"). */
  deletedAt?: string;
  sender?: User;
  /** Image attachments (OpenChat-6bg). */
  attachments?: Attachment[];
  /** Aggregated emoji reactions (openchat-bmp.1). */
  reactions?: Reaction[];
  /** Quoted reply target (openchat-bmp.2). */
  replyTo?: ReplyTo | null;
  /** Id of the message this is replying to (openchat-bmp.2). */
  replyToId?: string | null;
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

/**
 * Server-side search result shape (server/src/routes/chat.ts → GET /search).
 *
 * Message hits include the conversation's title + type so the UI can render
 * "Re: birthday plans (group)" without a separate lookup. Conversation hits
 * include up to 3 participants for the same "show me who's in here at a
 * glance" reason — full participant data still comes from the conversation
 * detail endpoint when the user opens it.
 */
export interface SearchMessageHit {
  id: string;
  content: string;
  conversationId: string;
  senderId: string;
  createdAt: string;
  sender?: { id: string; name: string; email: string };
  conversationTitle?: string | null;
  conversationType?: 'direct' | 'group';
}

export interface SearchConversationHit {
  id: string;
  title?: string | null;
  type: 'direct' | 'group';
  lastMessageAt?: string;
  lastMessagePreview?: string;
  participants?: Array<{ id: string; name: string; email: string }>;
}

export interface SearchResults {
  messages: SearchMessageHit[];
  conversations: SearchConversationHit[];
  contacts: User[];
}

// Auth response shape from Noos. We standardize on this from login,
// register, sso-exchange, and refresh.
export interface AuthResult {
  token: string;
  refreshToken?: string;
  user: User;
}

/**
 * Returned from createAgentKey — includes the full plaintext key (shown
 * once). The server may return `key_prefix` (snake) or `keyPrefix` (camel);
 * we normalize to `keyPrefix`. See openchat-bbr.
 */
export interface AgentKeyCreateResult {
  id: string;
  name: string;
  keyPrefix: string;
  key: string;
  scopes: string[];
}

export class ApiError extends Error {
  status: number;
  statusText: string;
  constructor(message: string, status: number, statusText: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

class ApiClient {
  private token: string | null = null;
  private authErrorHandler: (() => void) | null = null;

  setAuthErrorHandler(handler: (() => void) | null) {
    this.authErrorHandler = handler;
  }

  // Single-flight refresh: if a refresh is already in flight, all callers
  // await the same promise. Without this, a cold-load that fires 5 parallel
  // requests at the API will race 5 refresh calls — Noos rotates refresh
  // tokens (deletes the old RefreshToken before generating a new one in
  // src/routes/auth.ts), so 4 of 5 would fail and trigger a spurious logout
  // even though the 5th succeeded. See codex review 2026-05-30.
  private refreshPromise: Promise<boolean> | null = null;

  // Idempotent "auth has terminally expired" signal. Without this, a
  // failed refresh that's the recovery target of 10 concurrent 401s would
  // dispatch 10 noos:auth-expired events and the ChatContext listener
  // would call logout() 10 times.
  private authExpiredEmitted = false;

  // Refresh-loop guard. Counts successful refreshes that have NOT been
  // followed by any successful API call. The socket hook re-attempts a
  // refresh on every `Invalid token` connect_error, and a successful
  // refresh causes React to remount the effect (resetting any
  // per-effect-run flag). Without a session-scoped guard, a chat-server
  // that consistently rejects every new access token (e.g. JWT_SECRET
  // mismatch between Noos and the chat server, or a clock skew) would
  // churn refresh tokens forever. After REFRESH_LOOP_LIMIT consecutive
  // refreshes with no API success in between, we surrender — force
  // auth-expired so the user is sent to login instead of spinning. See
  // codex review 2026-05-30.
  private consecutiveRefreshes = 0;

  setToken(token: string | null) {
    this.token = token;
    // Allow the same in-process ApiClient instance to recover after a fresh
    // login by re-arming the auth-expired latch.
    if (token) this.authExpiredEmitted = false;
  }

  private getToken() {
    if (this.token) return this.token;
    try {
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored) {
        this.token = stored;
        return stored;
      }
    } catch {
      // localStorage may be unavailable in some environments.
    }
    return null;
  }

  private getRefreshToken(): string | null {
    try {
      return localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Wipe every `openchat_*` key we know about. Called on terminal refresh
   * failure and on explicit logout. Centralized so future keys don't leak
   * across sessions (the prior logout() left openchat_refresh_token in
   * place, which is a real fish-hook for the next user of a shared device).
   */
  private clearAuth(): void {
    this.token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      // localStorage unavailable — best effort.
    }
  }

  private emitTokenRefreshed(token: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(
        new CustomEvent(AUTH_EVENT_TOKEN_REFRESHED, { detail: { token } })
      );
    } catch {
      // Older browsers may lack CustomEvent constructor; non-fatal.
    }
  }

  private emitAuthExpired(): void {
    if (this.authExpiredEmitted) return;
    this.authExpiredEmitted = true;
    if (this.authErrorHandler) {
      try { this.authErrorHandler(); } catch { /* non-fatal */ }
    }
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new CustomEvent(AUTH_EVENT_AUTH_EXPIRED));
    } catch {
      // Non-fatal.
    }
  }

  /**
   * Single-flight refresh. Returns true if a fresh access token is now
   * stored and in-memory; false if refresh failed (and clearAuth() +
   * emitAuthExpired() have already fired).
   *
   * Multiple concurrent callers (REST + Socket + presence) share the same
   * promise so we hit /auth/refresh exactly once per refresh cycle.
   */
  async refreshAccessToken(): Promise<boolean> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<boolean> {
    // Refresh-loop guard: if we've already refreshed N times in a row
    // without any successful API call (REST 2xx, which would reset the
    // counter via maybeResetRefreshLoop()), the new token is being
    // rejected as fast as we mint it. Force-expire to break the loop.
    if (this.consecutiveRefreshes >= REFRESH_LOOP_LIMIT) {
      this.clearAuth();
      this.emitAuthExpired();
      return false;
    }
    this.consecutiveRefreshes++;

    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      this.clearAuth();
      this.emitAuthExpired();
      return false;
    }

    const url = `${NOOS_URL}/api/auth/refresh`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      this.clearAuth();
      this.emitAuthExpired();
      return false;
    }

    if (!response.ok) {
      // Don't report this as an httpError — it's an expected 4xx when
      // the refresh token has itself expired. Logs would just be noisy.
      this.clearAuth();
      this.emitAuthExpired();
      return false;
    }

    const data = await response.json().catch(() => null);
    if (!data?.accessToken) {
      this.clearAuth();
      this.emitAuthExpired();
      return false;
    }

    // Noos rotates refresh tokens — persist the new one.
    this.token = data.accessToken;
    try {
      localStorage.setItem(TOKEN_KEY, data.accessToken);
      if (data.refreshToken) {
        localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
      }
    } catch {
      // localStorage unavailable — token still works for this session.
    }

    this.emitTokenRefreshed(data.accessToken);
    return true;
  }

  private async fetch<T>(path: string, options: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const url = `${API_BASE}${path}`;
    // Bound the request when a timeout is given so callers like the message
    // REST fallback can't hang indefinitely on a stalled mobile/VPN link.
    // See OpenChat-60y.
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;
    const doFetch = async (token: string | null): Promise<Response> => {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      };
      if (token) {
        (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
      }
      return fetch(url, { ...options, headers, ...(controller ? { signal: controller.signal } : {}) });
    };

    try {
    let response: Response;
    try {
      response = await doFetch(this.getToken());
    } catch (error) {
      reportFetchError({ url, method: options.method || 'GET', error });
      throw error;
    }

    // On 401: try a single-flight refresh and retry once. If refresh
    // succeeds, the retry gets the new token from this.getToken(). If it
    // fails, refreshAccessToken() has already emitted noos:auth-expired
    // (which ChatContext will translate to logout + redirect), so we just
    // surface the 401 as-is for the caller.
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        try {
          response = await doFetch(this.getToken());
        } catch (error) {
          reportFetchError({ url, method: options.method || 'GET', error });
          throw error;
        }
      }
    }

    if (!response.ok) {
      // Don't double-report a 401 that we already attempted to recover
      // from; the original 401 isn't actionable telemetry. Anything else
      // (or a still-401 after refresh, which means the new token is also
      // somehow rejected) is.
      if (response.status !== 401) {
        reportHttpError({
          url,
          method: options.method || 'GET',
          status: response.status,
          statusText: response.statusText,
        });
      }
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    // Any successful API call proves the current token is honored by the
    // backend. Reset the refresh-loop counter so the next legitimate
    // 401-after-15-min-of-use still gets the full retry budget.
    this.consecutiveRefreshes = 0;
    return response.json();
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  // === REST endpoints ===

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

  async updateConversation(id: string, patch: { title?: string }): Promise<Conversation> {
    return this.fetch(`/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async addParticipant(conversationId: string, userId: string): Promise<Conversation> {
    return this.fetch(`/conversations/${conversationId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async removeParticipant(conversationId: string, userId: string): Promise<Conversation> {
    return this.fetch(`/conversations/${conversationId}/participants/${userId}`, {
      method: 'DELETE',
    });
  }

  async leaveConversation(conversationId: string): Promise<{ left: true }> {
    return this.fetch(`/conversations/${conversationId}/leave`, {
      method: 'POST',
    });
  }

  async getMessages(conversationId: string, limit = 50, before?: string): Promise<{ messages: Message[]; hasMore: boolean }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.append('before', before);
    return this.fetch(`/conversations/${conversationId}/messages?${params}`);
  }

  async sendMessage(conversationId: string, content: string, messageType = 'text', attachments?: Attachment[], id?: string, replyToId?: string): Promise<Message> {
    // id is the client-generated idempotency key shared with the WebSocket path
    // so a WS-then-REST retry doesn't persist twice. See OpenChat-60y. The 15s
    // timeout keeps the REST fallback from hanging on a stalled mobile/VPN link.
    return this.fetch(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, messageType, ...(attachments?.length ? { attachments } : {}), id, ...(replyToId ? { replyToId } : {}) }),
    }, 15000);
  }

  /** Mark the conversation read for the caller (OpenChat-0nj / openchat-bmp.4). */
  async markConversationRead(conversationId: string): Promise<{ ok: true; lastReadAt: string; readMap: Record<string, string | null>; onlineMap: Record<string, boolean> }> {
    return this.fetch(`/conversations/${conversationId}/read`, { method: 'PATCH' });
  }

  /** Add an emoji reaction to a message (openchat-bmp.1). */
  async addReaction(messageId: string, emoji: string): Promise<{ reactions: Reaction[] }> {
    return this.fetch(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  }

  /** Remove the caller's emoji reaction from a message (openchat-bmp.1). */
  async removeReaction(messageId: string, emoji: string): Promise<{ reactions: Reaction[] }> {
    return this.fetch(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Get a presigned PUT URL for uploading an image attachment. (OpenChat-6bg)
   * Returns { putUrl, getUrl, key }.
   */
  async presignAttachment(params: { filename: string; mimeType: string; sizeBytes: number }): Promise<{ putUrl: string; getUrl: string; key: string }> {
    return this.fetch('/attachments/presign', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  // Edit/delete hit the top-level /messages/:id routes (server/src/routes/chat.ts).
  // They return the updated message (delete is a soft-delete that rewrites
  // content to "Message deleted" and sets deletedAt). See openchat-bmp.3.
  async editMessage(messageId: string, content: string): Promise<Message> {
    return this.fetch(`/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
  }

  async deleteMessage(messageId: string): Promise<Message> {
    return this.fetch(`/messages/${messageId}`, {
      method: 'DELETE',
    });
  }

  async searchUsers(query: string): Promise<User[]> {
    return this.fetch(`/users/search?q=${encodeURIComponent(query)}`);
  }

  async getContacts(search?: string): Promise<User[]> {
    const path = search ? `/contacts?q=${encodeURIComponent(search)}` : '/contacts';
    return this.fetch(path);
  }

  /**
   * Unified search across messages, conversations, and contacts.
   *
   * Server: GET /api/chat/search (see server/src/routes/chat.ts).
   * Returns three buckets — each capped at the requested `limit`.
   * Server enforces participant-level access on messages/conversations,
   * so the client doesn't need to filter again.
   */
  async search(params: {
    q: string;
    scope?: 'global' | 'conversation';
    conversationId?: string;
    limit?: number;
  }): Promise<SearchResults> {
    const qs = new URLSearchParams({ q: params.q });
    if (params.scope) qs.set('scope', params.scope);
    if (params.conversationId) qs.set('conversationId', params.conversationId);
    if (params.limit) qs.set('limit', String(params.limit));
    return this.fetch(`/search?${qs.toString()}`);
  }

  async updatePresence(presenceStatus: string, statusMessage?: string): Promise<void> {
    return this.fetch('/presence', {
      method: 'PUT',
      body: JSON.stringify({ presenceStatus, statusMessage }),
    });
  }

  // ── Group invite endpoints (OpenChat-240) ──────────────────────────────────

  async createInvite(
    conversationId: string,
    opts?: { expiresInDays?: number; maxUses?: number }
  ): Promise<{ token: string; url: string; expiresAt: string; usesLeft: number }> {
    return this.fetch(`/conversations/${conversationId}/invites`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    });
  }

  async getInvitePreview(
    token: string
  ): Promise<{ conversationId: string; conversationTitle: string | null; memberCount: number; expiresAt: string }> {
    return this.fetch(`/invites/${token}`);
  }

  async acceptInvite(
    token: string
  ): Promise<{ conversationId: string; conversation: Conversation }> {
    return this.fetch(`/invites/${token}/accept`, { method: 'POST' });
  }

  async revokeInvite(conversationId: string, token: string): Promise<{ ok: boolean }> {
    return this.fetch(`/conversations/${conversationId}/invites/${token}`, { method: 'DELETE' });
  }

  // === Auth endpoints (via Noos) ===

  async login(email: string, password: string): Promise<AuthResult> {
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
      refreshToken: data.refreshToken,
      user: data.user,
    };
  }

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

  async register(email: string, password: string, name: string): Promise<AuthResult> {
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
      refreshToken: data.refreshToken,
      user: data.user,
    };
  }

  /**
   * Get the authenticated user. The endpoint lives at `${AUTH_BASE}/me`, not
   * `${API_BASE}/me`. The prior implementation used
   * `this.fetch('/me'.replace('/chat', '/auth'))` which silently expanded
   * to `/api/chat/me` (the .replace matched nothing in just '/me'). Tried
   * via this.fetch the call would 404 and bubble as "Request failed".
   * See codex review 2026-05-30.
   */
  async getMe(): Promise<User> {
    const url = `${AUTH_BASE}/me`;
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      reportFetchError({ url, method: 'GET', error });
      throw error;
    }

    // Same 401-then-refresh-then-retry pattern as the chat fetch wrapper.
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        const retryHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        const newToken = this.getToken();
        if (newToken) retryHeaders['Authorization'] = `Bearer ${newToken}`;
        try {
          response = await fetch(url, { headers: retryHeaders });
        } catch (error) {
          reportFetchError({ url, method: 'GET', error });
          throw error;
        }
      }
    }

    if (!response.ok) {
      if (response.status !== 401) {
        reportHttpError({ url, method: 'GET', status: response.status, statusText: response.statusText });
      }
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    this.consecutiveRefreshes = 0;
    return response.json();
  }

  /**
   * Log out. Best-effort: tells the server to invalidate the refresh
   * token, then clears local state. The server call is non-blocking from
   * the caller's perspective — failure (e.g. already-expired access
   * token, network down) does not prevent local cleanup.
   */
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
    } catch {
      // Ignore; we're tearing down regardless.
    }
    this.clearAuth();
  }

  // Ask our server for the Google authorization URL. The server holds the
  // client_id and decides redirect_uri + scopes. We just redirect the browser.
  async googleAuthUrl(opts?: { state?: string; redirectUri?: string; prompt?: string }): Promise<{ url: string; state: string; redirectUri: string }> {
    const url = new URL(`${AUTH_BASE}/google/url`, window.location.origin);
    if (opts?.state) url.searchParams.set('state', opts.state);
    if (opts?.redirectUri) url.searchParams.set('redirect_uri', opts.redirectUri);
    if (opts?.prompt) url.searchParams.set('prompt', opts.prompt);

    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (error) {
      reportFetchError({ url: url.toString(), method: 'GET', error });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({ url: url.toString(), method: 'GET', status: response.status, statusText: response.statusText });
      const e = await response.json().catch(() => ({ error: 'Could not start Google sign-in' }));
      throw new Error(e.error || 'Could not start Google sign-in');
    }
    return response.json();
  }

  // Exchange Google auth code for an OpenChat JWT. Same return shape as
  // devLogin so the ChatContext handler can be near-identical.
  async googleExchange(code: string, redirectUri: string): Promise<{ token: string; user: User; expiresIn: number; provider: string }> {
    const url = `${AUTH_BASE}/google/exchange`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri }),
      });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }

    if (!response.ok) {
      reportHttpError({ url, method: 'POST', status: response.status, statusText: response.statusText });
      const e = await response.json().catch(() => ({ error: 'Google sign-in failed' }));
      throw new Error(e.error || 'Google sign-in failed');
    }
    return response.json();
  }

  // Exchange SSO code/token from Noos for full auth tokens. Returns AuthResult
  // (including refreshToken) so callers can persist it — was previously
  // dropping refreshToken on the floor; see OpenChat-bo6.
  async ssoExchange(payload: { code?: string; token?: string }): Promise<AuthResult> {
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
    return {
      token: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    };
  }

  /**
   * Mint a new agent key. Returns the full plaintext key once (openchat-bbr).
   * Endpoint lives at `/api/agent-keys`, NOT under `${API_BASE}` (/api/chat),
   * so we hit it directly and mirror the same 401-then-refresh-then-retry
   * pattern as getMe(). Auth = the user's session JWT.
   */
  async createAgentKey(name: string, scopes?: string[]): Promise<AgentKeyCreateResult> {
    const url = '/api/agent-keys';
    const body = JSON.stringify({ name, ...(scopes ? { scopes } : {}) });
    const buildHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = this.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return headers;
    };

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: buildHeaders(), body });
    } catch (error) {
      reportFetchError({ url, method: 'POST', error });
      throw error;
    }

    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        try {
          response = await fetch(url, { method: 'POST', headers: buildHeaders(), body });
        } catch (error) {
          reportFetchError({ url, method: 'POST', error });
          throw error;
        }
      }
    }

    if (!response.ok) {
      if (response.status !== 401) {
        reportHttpError({ url, method: 'POST', status: response.status, statusText: response.statusText });
      }
      const error = await response.json().catch(() => ({ error: 'Failed to create agent key' }));
      throw new Error(error.error || 'Failed to create agent key');
    }

    this.consecutiveRefreshes = 0;
    const data = await response.json();
    return {
      id: data.id,
      name: data.name,
      keyPrefix: data.keyPrefix ?? data.key_prefix ?? '',
      key: data.key,
      scopes: data.scopes ?? [],
    };
  }
}

export const api = new ApiClient();
