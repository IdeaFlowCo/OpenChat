/**
 * Thin wrapper around the OpenChat REST API.
 *
 * Configuration (priority order):
 *   1. OPENCHAT_API_KEY env var   — the `oc_…` token
 *   2. ~/.openchat/credentials.json  — { apiKey, baseUrl }
 *
 * Auth: `Authorization: Bearer ${apiKey}` on every request.
 *
 * Default base URL: https://chat.ideaflow.app  (overridable via
 *   OPENCHAT_BASE_URL env var or credentials.json baseUrl field).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'https://chat.ideaflow.app';
const CREDENTIALS_PATH = join(homedir(), '.openchat', 'credentials.json');

// ---- types ----

/** The private-graph route for a subject: an OpenChat person, a saved thing, or an Unlinked profile. */
const privateSubjectPath = (subject: { kind: 'user' | 'thing' | 'unlinked'; id: string }) =>
  `/api/private/${subject.kind === 'user' ? 'people' : subject.kind === 'unlinked' ? 'unlinked-people' : 'things'}/${encodeURIComponent(subject.id)}`;

export interface OpenChatConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface ContextPost {
  id: string;
  conversationId: string;
  authorId: string;
  text: string;
  kind: string; // 'note' | 'ask' | 'offer'
  lane: 'context';
  revision: number;
  createdAt: string;
  updatedAt: string;
  replyToId?: string;
  clientRequestId: string;
  isDeleted?: boolean;
}

export interface ListContextPostsResponse {
  posts: ContextPost[];
  nextCursor?: string;
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
  goal?: string;
  seeks?: string[];
  brings?: string[];
  matchingMode?: MatchingMode;
  openToCollaborators?: boolean;
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

    setContextRequestsEnabled: (enabled: boolean) => request<{ enabled: boolean }>('PUT', '/api/chat/context-agent/preferences', { body: { enabled } }),
    listContextAgentRequests: () => request<unknown>('GET', '/api/chat/context-agent/requests'),
    askContextAgents: (conversationId: string, postId: string) => request<unknown>('POST', `/api/chat/conversations/${encodeURIComponent(conversationId)}/context/${encodeURIComponent(postId)}/ask-agents`),
    respondToContextAgentRequest: (requestId: string, text?: string, decline?: boolean) => request<unknown>('POST', `/api/chat/context-agent/requests/${encodeURIComponent(requestId)}/respond`, { body: { text, decline } }),
    listConversationContent: (conversationId:string,filter?:string,search?:string,cursor?:string,limit?:number) =>
      request<unknown>('GET', `/api/chat/conversations/${encodeURIComponent(conversationId)}/content`, {query:{filter,search,cursor,limit}}),
    // ---- context lane ----
    listContextPosts: (conversationId: string, limit?: number, cursor?: string, kind?: string, search?: string) =>
      request<ListContextPostsResponse>('GET', `/api/chat/conversations/${encodeURIComponent(conversationId)}/context`, { query: { limit, cursor, kind, search } }),
    createContextPost: (conversationId: string, text: string, clientRequestId: string, kind?: string, replyToId?: string) =>
      request<ContextPost>('POST', `/api/chat/conversations/${encodeURIComponent(conversationId)}/context`, { body: { text, clientRequestId, kind, replyToId } }),
    updateContextPost: (conversationId: string, postId: string, text: string, expectedRevision: number) =>
      request<ContextPost>('PATCH', `/api/chat/conversations/${encodeURIComponent(conversationId)}/context/${encodeURIComponent(postId)}`, { body: { text, expectedRevision } }),
    deleteContextPost: (conversationId: string, postId: string) =>
      request<void>('DELETE', `/api/chat/conversations/${encodeURIComponent(conversationId)}/context/${encodeURIComponent(postId)}`),

    // ---- messages ----
    getMessages: (conversationId: string, limit?: number) =>
      request<Message[]>(
        'GET',
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
        { query: { limit } }
      ),

    sendMessage: (
      conversationId: string,
      body: { content: string; attachments?: unknown[]; id?: string; clientRequestId?: string }
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
    publishIntent: (body: { kind: IntentKind; terms: string; details?: string; expiresAt?: string; confirm: true }) =>
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

    // ---- private graph: the owner's own notes, importance, cadence and links ----
    getPrivatePerson: (userId: string) =>
      request<unknown>('GET', `/api/private/people/${encodeURIComponent(userId)}`),
    updatePrivatePerson: (userId: string, body: Record<string, unknown>) =>
      request<unknown>('PATCH', `/api/private/people/${encodeURIComponent(userId)}`, { body }),
    addPrivateNote: (subject: { kind: 'user' | 'thing' | 'unlinked'; id: string }, text: string) =>
      request<unknown>('POST', `${privateSubjectPath(subject)}/notes`, { body: { text } }),
    deletePrivateNote: (noteId: string) =>
      request<unknown>('DELETE', `/api/private/notes/${encodeURIComponent(noteId)}`),
    addPrivateLink: (subject: { kind: 'user' | 'thing' | 'unlinked'; id: string }, relation: string, to: Record<string, unknown>) =>
      request<unknown>('POST', `${privateSubjectPath(subject)}/links`, { body: { relation, to } }),
    getUnlinkedPersonPrivate: (profileId: string) =>
      request<unknown>('GET', `/api/private/unlinked-people/${encodeURIComponent(profileId)}`),
    resolvePrivateThing: (body: Record<string, unknown>) =>
      request<unknown>('POST', '/api/private/things/resolve', { body }),
    listPrivateLinks: (query?: string) =>
      request<unknown>('GET', '/api/private/links', { query: { q: query } }),
    deletePrivateLink: (linkId: string) =>
      request<unknown>('DELETE', `/api/private/links/${encodeURIComponent(linkId)}`),
    listPrivateThings: (query?: string, kind?: string) =>
      request<unknown>('GET', '/api/private/things', { query: { q: query, kind } }),
    getPrivateThing: (thingId: string) =>
      request<unknown>('GET', `/api/private/things/${encodeURIComponent(thingId)}`),
    deletePrivateThing: (thingId: string) =>
      request<unknown>('DELETE', `/api/private/things/${encodeURIComponent(thingId)}`),
    listCatchUp: () => request<unknown>('GET', '/api/private/due'),

    updateIntentDraft: (id: string, body: Record<string, unknown>) =>
      request<{ draft: IntentDraft }>('PATCH', `/api/intent-drafts/${encodeURIComponent(id)}`, { body }),

    activateIntentDraft: (id: string, body: {
      confirm: boolean;
      approvalGrant?: string;
      quietSearch?: { enabled: boolean; expiresAt?: string; audience?: SocialAudience };
      story?: { enabled: boolean; text: string; expiresAt?: string; audience: SocialAudience };
      closeOnConnect?: boolean;
    }) => request<{ draft: IntentDraft; story: OwnedStory; intent: AgentIntent }>(
      'POST', `/api/intent-drafts/${encodeURIComponent(id)}/activate`, { body },
    ),

    listOwnedStories: () =>
      request<{ stories: OwnedStory[] }>('GET', '/api/stories/mine'),

    listStoryFeed: (authorId?: string) =>
      request<{ stories: FeedStory[] }>('GET', `/api/stories/feed${authorId ? `?author=${encodeURIComponent(authorId)}` : ''}`),

    createStory: (body: {
      confirm: boolean;
      approvalGrant?: string;
      kind?: IntentKind;
      text: string;
      audience: SocialAudience;
      goal?: string;
      seeks?: string[];
      brings?: string[];
      matchingMode?: MatchingMode;
      openToCollaborators?: boolean;
      storyExpiresAt: string;
      quietSearch?: { enabled: boolean; expiresAt?: string; audience?: SocialAudience };
      closeOnConnect?: boolean;
    }) => request<{ story: OwnedStory; intent: AgentIntent }>('POST', '/api/stories', { body }),

    updateStory: (id: string, body: { status?: 'active' | 'paused' | 'withdrawn'; storyExpiresAt?: string }) =>
      request<{ story: OwnedStory }>('PATCH', `/api/stories/${encodeURIComponent(id)}`, {
        body,
      }),

    withdrawStory: (id: string) =>
      request<{ story: OwnedStory }>('PATCH', `/api/stories/${encodeURIComponent(id)}`, { body: { status: 'withdrawn' } }),

    respondStory: (id: string, message: string, confirm: boolean, approvalGrant?: string) =>
      request<unknown>('POST', `/api/stories/${encodeURIComponent(id)}/respond`, {
        body: { message, confirm, ...(approvalGrant ? { approvalGrant } : {}) },
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
