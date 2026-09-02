/**
 * Thin wrapper around the OpenChat REST API.
 *
 * Configuration (priority order):
 *   1. OPENCHAT_API_KEY env var   — the `oc_…` token
 *   2. ~/.openchat/credentials.json  — { apiKey, baseUrl }
 *
 * Auth: `Authorization: Bearer ${apiKey}` on every request.
 *
 * Default base URL: https://chat.globalbr.ai  (overridable via
 *   OPENCHAT_BASE_URL env var or credentials.json baseUrl field).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'https://chat.globalbr.ai';
const CREDENTIALS_PATH = join(homedir(), '.openchat', 'credentials.json');

// ---- types ----

export interface OpenChatConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface ConversationSummary {
  id: string;
  title?: string | null;
  type?: string;
  lastMessageAt?: string;
  lastMessage?: {
    content?: string;
    senderId?: string;
    createdAt?: string;
  } | null;
  participants?: Array<{
    user?: { id?: string; name?: string; email?: string; isBot?: boolean };
    role?: string;
  }>;
  [k: string]: unknown;
}

export interface Message {
  id: string;
  content?: string;
  senderId?: string;
  conversationId?: string;
  createdAt?: string;
  sender?: { id?: string; name?: string; email?: string };
  reactions?: Array<{ emoji: string; count: number; byMe: boolean; kind?: string | null; href?: string | null }>;
  attachments?: unknown[];
  [k: string]: unknown;
}

export interface User {
  id: string;
  name?: string;
  email?: string;
  presenceStatus?: string;
  statusMessage?: string;
  isBot?: boolean;
  [k: string]: unknown;
}

/** A contact returned by GET /api/chat/contacts. */
export interface Contact {
  id: string;
  name?: string | null;
  email?: string | null;
  presenceStatus?: string | null;
  statusMessage?: string | null;
  lastSeenAt?: string | null;
  isBot?: boolean | null;
  [k: string]: unknown;
}

/** A message hit returned inside the search response. */
export interface SearchMessageHit extends Message {
  conversationTitle?: string | null;
  conversationType?: string | null;
}

/** Shape of GET /api/chat/search. */
export interface SearchResult {
  messages?: SearchMessageHit[];
  conversations?: ConversationSummary[];
  contacts?: Contact[];
  [k: string]: unknown;
}

export type IntentKind = 'ask' | 'offer';
export type IntentStatus = 'active' | 'paused' | 'withdrawn' | 'connected';

/** An intent owned by the authenticated user. */
export interface AgentIntent {
  id: string;
  ownerUserId: string;
  kind: IntentKind;
  terms: string;
  details?: string | null;
  status: IntentStatus;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  [k: string]: unknown;
}

export type MatchViewerStatus = 'pending' | 'awaiting_other' | 'closed' | 'connected';

/** Privacy-safe, per-viewer projection returned by the matches API. */
export interface AgentMatchView {
  id: string;
  status: MatchViewerStatus;
  ownIntent: Pick<AgentIntent, 'id' | 'kind' | 'terms'>;
  otherKind: IntentKind;
  otherTerms: string;
  createdAt: string;
  updatedAt: string;
  conversationId?: string;
  alreadyResolved?: boolean;
  [k: string]: unknown;
}

export type MatchingMode = 'fulfillment' | 'reciprocal' | 'shared_goal';
export interface SocialAudience { userIds: string[]; conversationIds: string[] }
export interface IntentDraft {
  id: string;
  ownerUserId: string;
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  openToCollaborators: boolean;
  details?: string | null;
  source?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence?: number | null;
  state: 'pending' | 'dismissed' | 'activated';
  activatedIntentId?: string | null;
  activatedStoryId?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OwnedStory {
  id: string;
  ownerUserId: string;
  text?: string | null;
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  status: 'active' | 'paused' | 'withdrawn';
  audience: SocialAudience;
  storyExpiresAt?: string | null;
  searchExpiresAt: string;
  intentId: string;
  [k: string]: unknown;
}
export interface FeedStory {
  id: string;
  author: { id: string; name: string | null };
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  openToCollaborators: boolean;
  text: string;
  storyExpiresAt: string;
  createdAt: string;
}
export interface SocialPreferences {
  experienceMode: 'enhanced' | 'simple';
  networkPaused: boolean;
  updatedAt: string | null;
}

export class OpenChatApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string
  ) {
    super(`OpenChat API ${status} on ${url}: ${body.slice(0, 200)}`);
    this.name = 'OpenChatApiError';
  }
}

// ---- config loading ----

function loadCredentialsFile(): Partial<OpenChatConfig> {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<{ apiKey: string; baseUrl: string }>;
    return {
      apiKey: parsed.apiKey,
      baseUrl: parsed.baseUrl,
    };
  } catch {
    return {};
  }
}

export function getConfig(): OpenChatConfig {
  const fileCreds = loadCredentialsFile();
  const baseUrl = (
    process.env.OPENCHAT_BASE_URL ||
    fileCreds.baseUrl ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const apiKey = process.env.OPENCHAT_API_KEY || fileCreds.apiKey;
  return { baseUrl, apiKey };
}

// ---- HTTP factory ----

function makeRequest(config: OpenChatConfig) {
  return async function request<T = unknown>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const url = new URL(config.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    const text = await res.text();
    if (!res.ok) throw new OpenChatApiError(res.status, text, url.toString());
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  };
}

// ---- API methods ----

function buildApiMethods(request: ReturnType<typeof makeRequest>) {
  return {
    // ---- identity ----
    whoami: () =>
      request<User>('GET', '/api/auth/me'),

    // ---- conversations ----
    listConversations: () =>
      request<ConversationSummary[]>('GET', '/api/chat/conversations'),

    getConversation: (id: string) =>
      request<ConversationSummary>('GET', `/api/chat/conversations/${encodeURIComponent(id)}`),

    createConversation: (body: {
      participantIds: string[];
      title?: string;
      type?: 'direct' | 'group';
    }) => request<ConversationSummary>('POST', '/api/chat/conversations', { body }),

    // ---- messages ----
    getMessages: (conversationId: string, limit?: number) =>
      request<Message[]>(
        'GET',
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
        { query: { limit } }
      ),

    sendMessage: (
      conversationId: string,
      body: { content: string; attachments?: unknown[] }
    ) =>
      request<Message>(
        'POST',
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
        { body }
      ),

    // ---- search ----
    searchMessages: (q: string, limit?: number) =>
      request<SearchResult>('GET', '/api/chat/search', { query: { q, limit } }),

    // ---- contacts ----
    listContacts: (q?: string) =>
      request<Contact[]>('GET', '/api/chat/contacts', { query: { q } }),

    // ---- feedback ----
    submitFeedback: (body: { message: string; context?: string }) =>
      request<{ url?: string; id?: string }>('POST', '/api/feedback', { body }),

    // ---- reactions ----
    // `kind` + `href` tag a semantic reaction, e.g. a 'filed' receipt linking
    // to the KB page a bot created (openchat-reaction-kind).
    addReaction: (messageId: string, emoji: string, kind?: string, href?: string) =>
      request<unknown>('POST', `/api/chat/messages/${encodeURIComponent(messageId)}/reactions`, {
        body: { emoji, ...(kind ? { kind } : {}), ...(href ? { href } : {}) },
      }),

    // ---- users ----
    getUserByEmail: (email: string) =>
      request<User>('GET', `/api/chat/users/by-email/${encodeURIComponent(email)}`),

    // ---- agent keys ----
    listAgentKeys: () =>
      request<unknown[]>('GET', '/api/agent-keys'),

    createAgentKey: (body: { name: string; scopes?: string[]; expiresAt?: string }) =>
      request<{ id: string; key: string; name: string; scopes?: string[] }>(
        'POST',
        '/api/agent-keys',
        { body }
      ),

    // ---- asks, offers, and quiet matches ----
    publishIntent: (body: { kind: IntentKind; terms: string; details?: string; expiresAt?: string }) =>
      request<{ intent: AgentIntent }>('POST', '/api/intents', { body }),

    listIntents: () =>
      request<{ intents: AgentIntent[] }>('GET', '/api/intents'),

    withdrawIntent: (id: string) =>
      request<{ intent: AgentIntent }>('PATCH', `/api/intents/${encodeURIComponent(id)}`, {
        body: { status: 'withdrawn' },
      }),

    listMatches: () =>
      request<{ matches: AgentMatchView[] }>('GET', '/api/matches'),

    respondMatch: (id: string, decision: 'approve' | 'decline') =>
      request<{ match: AgentMatchView }>('POST', `/api/matches/${encodeURIComponent(id)}/respond`, {
        body: { decision },
      }),

    // ---- private capture, Stories, preferences, and review ----
    createIntentDraft: (body: {
      goal?: string;
      seeks?: string[];
      brings?: string[];
      matchingMode?: MatchingMode;
      openToCollaborators?: boolean;
      details?: string;
      source?: string;
      provenance?: Record<string, unknown>;
      confidence?: number;
    }) => request<{ draft: IntentDraft }>('POST', '/api/intent-drafts', { body }),

    listIntentDrafts: () =>
      request<{ drafts: IntentDraft[] }>('GET', '/api/intent-drafts'),

    updateIntentDraft: (id: string, body: Record<string, unknown>) =>
      request<{ draft: IntentDraft }>('PATCH', `/api/intent-drafts/${encodeURIComponent(id)}`, { body }),

    activateIntentDraft: (id: string, body: {
      quietSearch?: { enabled: boolean; expiresAt?: string; audience?: SocialAudience };
      story?: { enabled: boolean; text: string; expiresAt?: string; audience: SocialAudience };
      closeOnConnect?: boolean;
    }) => request<{ draft: IntentDraft; story: OwnedStory; intent: AgentIntent }>(
      'POST', `/api/intent-drafts/${encodeURIComponent(id)}/activate`, { body },
    ),

    listOwnedStories: () =>
      request<{ stories: OwnedStory[] }>('GET', '/api/stories/mine'),

    listStoryFeed: () =>
      request<{ stories: FeedStory[] }>('GET', '/api/stories/feed'),

    createStory: (body: {
      text: string;
      audience: SocialAudience;
      goal?: string;
      seeks?: string[];
      brings?: string[];
      matchingMode?: MatchingMode;
      openToCollaborators?: boolean;
      storyExpiresAt?: string;
      quietSearch?: { enabled: boolean; expiresAt?: string; audience?: SocialAudience };
      closeOnConnect?: boolean;
    }) => request<{ story: OwnedStory; intent: AgentIntent }>('POST', '/api/stories', { body }),

    updateStory: (id: string, body: { status?: 'active' | 'paused' | 'withdrawn'; storyExpiresAt?: string }) =>
      request<{ story: OwnedStory }>('PATCH', `/api/stories/${encodeURIComponent(id)}`, {
        body,
      }),

    withdrawStory: (id: string) =>
      request<{ story: OwnedStory }>('PATCH', `/api/stories/${encodeURIComponent(id)}`, { body: { status: 'withdrawn' } }),

    respondStory: (id: string, message: string) =>
      request<{ conversationId: string; message: Message }>('POST', `/api/stories/${encodeURIComponent(id)}/respond`, {
        body: { message },
      }),

    getSocialPreferences: () =>
      request<SocialPreferences>('GET', '/api/social/preferences'),

    updateSocialPreferences: (body: Partial<Pick<SocialPreferences, 'experienceMode' | 'networkPaused'>>) =>
      request<SocialPreferences>('PATCH', '/api/social/preferences', { body }),

    getReviewQueue: () =>
      request<{ items: unknown[]; hasMore: boolean }>('GET', '/api/review'),
  };
}

/** API client type. */
export type OpenChatApi = ReturnType<typeof buildApiMethods> & {
  baseUrl: string;
  hasApiKey: boolean;
};

/** Create a per-request API client bound to the given config. */
export function createApi(config: OpenChatConfig): OpenChatApi {
  const request = makeRequest(config);
  return {
    ...buildApiMethods(request),
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
  };
}
