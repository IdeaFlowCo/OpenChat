/**
 * parseOpenChatUrl — parses an `openchat://` deep-link URL into a typed result.
 *
 * Supported shapes:
 *   openchat://user/<userId>?v=1    → { type: 'user', userId }
 *   openchat://invite/<token>       → { type: 'invite', token }
 *   openchat://card/<token>         → { type: 'card', token }   (AddMe card)
 *   https://chat.ideaflow.app/c/<t> → { type: 'card', token }
 *   https://chat.globalbr.ai/c/<t> → { type: 'card', token } (legacy)
 *   Both hosts also accept /u/<id>, /i/<token>, and /app/?intent=... links.
 *   https://chat.ideaflow.app/app/original/<thoughtId> → { type: 'original', thoughtId }
 *   https://chat.ideaflow.app/app/chat/<conversationId> → { type: 'conversation', conversationId }
 *   anything else                   → { type: 'unknown' }
 */

import { parseComposeIntent, type ComposeIntent } from './composeIntent';

export type ParsedOpenChatUrl =
  | { type: 'user'; userId: string }
  | { type: 'invite'; token: string }
  | { type: 'card'; token: string }
  | { type: 'context'; conversationId: string; entryId: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'original'; thoughtId: string }
  | { type: 'message'; messageId: string }
  | ({ type: 'compose' } & ComposeIntent)
  | { type: 'unknown' };

/** Shareable web link to a Stream entry's original message (parsed back as `original`). */
export const originalMessageUrl = (thoughtId: string) => `https://chat.ideaflow.app/app/original/${encodeURIComponent(thoughtId)}`;
/** Shareable web link that opens a conversation (parsed back as `conversation`). */
export const conversationUrl = (conversationId: string) => `https://chat.ideaflow.app/app/chat/${encodeURIComponent(conversationId)}`;

/** Stable message link. Opening it always rechecks conversation membership. */
export const messageUrl = (messageId: string) => `https://chat.ideaflow.app/app/message?${new URLSearchParams({ id: messageId })}`;

// IDs are opaque: REST/WebSocket clients can supply punctuation, slashes and
// Unicode. Decode one path segment exactly once, then keep it as bound data.
export function decodeMessageId(encoded: string): string | null {
  try { const value = decodeURIComponent(encoded); return value.length > 0 ? value : null; }
  catch { return null; }
}

export function parseOpenChatUrl(raw: string): ParsedOpenChatUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { type: 'unknown' };
  }

  if (url.protocol === 'openchat:' && url.hostname === 'message') {
    const queryId = url.searchParams.get('id');
    if ((!url.pathname || url.pathname === '/') && queryId) return { type: 'message', messageId: queryId };
    const segment = url.pathname.match(/^\/([^/]+)$/)?.[1];
    const id = segment ? decodeMessageId(segment) : null;
    if (id !== null) return { type: 'message', messageId: id };
  }

  // openchat://user/<userId>
  if (url.protocol === 'openchat:' && url.hostname === 'user') {
    const userId = url.pathname.replace(/^\//, '');
    if (userId) return { type: 'user', userId };
  }

  // openchat://invite/<token>
  if (url.protocol === 'openchat:' && url.hostname === 'invite') {
    const token = url.pathname.replace(/^\//, '');
    if (token) return { type: 'invite', token };
  }

  // openchat://card/<token>
  if (url.protocol === 'openchat:' && url.hostname === 'card') {
    const token = url.pathname.replace(/^\//, '');
    if (token) return { type: 'card', token };
  }

  // openchat://context/<conversationId>/<entryId>
  if (url.protocol === 'openchat:' && url.hostname === 'context') {
    const parts = url.pathname.replace(/^\//, '').split('/');
    if (parts.length >= 2) return { type: 'context', conversationId: parts[0], entryId: parts[1] };
  }

  // Both public hosts accept user, invite, and card web links.
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (url.hostname === 'chat.ideaflow.app' || url.hostname === 'chat.globalbr.ai'
      || url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    const userMatch = url.pathname.match(/^\/u\/(.+)$/);
    if (userMatch?.[1]) return { type: 'user', userId: userMatch[1] };

    const inviteMatch = url.pathname.match(/^\/i\/(.+)$/);
    if (inviteMatch?.[1]) return { type: 'invite', token: inviteMatch[1] };

    const cardMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (cardMatch?.[1]) return { type: 'card', token: cardMatch[1] };

    if (/^\/app\/message\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('id');
      if (id) return { type: 'message', messageId: id };
    }
    const messageMatch = url.pathname.match(/^\/app\/message\/([^/]+)\/?$/);
    if (messageMatch) {
      const id = decodeMessageId(messageMatch[1]);
      if (id !== null) return { type: 'message', messageId: id };
    }

    // A Stream entry's original message; the screen re-checks access on open.
    const originalMatch = url.pathname.match(/^\/app\/original\/([^\/]+)\/?$/);
    if (originalMatch?.[1]) return { type: 'original', thoughtId: decodeURIComponent(originalMatch[1]) };

    // A conversation (e.g. a group's default chat linked from the Ideaflow ideas network);
    // the Chat screen re-checks membership on open.
    const conversationMatch = url.pathname.match(/^\/app\/chat\/([A-Za-z0-9_-]{1,80})\/?$/);
    if (conversationMatch?.[1]) return { type: 'conversation', conversationId: conversationMatch[1] };

    const contextMatch = url.pathname.match(/^\/app\/context\/([^\/]+)\/([^\/]+)$/);
    if (contextMatch?.[1] && contextMatch?.[2]) return { type: 'context', conversationId: contextMatch[1], entryId: contextMatch[2] };

    // The responsive web client lives at /app/. Server-rendered public pages
    // carry their post-auth destination in the query so OAuth can always
    // return to the one registered /app/ callback.
    if (/^\/app\/?$/.test(url.pathname)) {
      const compose = parseComposeIntent(url);
      if (compose) return { type: 'compose', ...compose };
      const intent = url.searchParams.get('intent');
      const id = url.searchParams.get('id');
      const token = url.searchParams.get('token');
      if (intent === 'add-user' && id) return { type: 'user', userId: id };
      if (intent === 'invite' && token) return { type: 'invite', token };
      if (intent === 'card' && token) return { type: 'card', token };
    }
  }

  return { type: 'unknown' };
}
