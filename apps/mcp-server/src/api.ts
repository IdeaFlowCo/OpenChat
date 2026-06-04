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
  reactions?: Array<{ emoji: string; count: number; byMe: boolean }>;
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

    // ---- reactions ----
    addReaction: (messageId: string, emoji: string) =>
      request<unknown>('POST', `/api/chat/messages/${encodeURIComponent(messageId)}/reactions`, {
        body: { emoji },
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
