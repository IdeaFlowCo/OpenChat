/**
 * parseOpenChatUrl — parses an `openchat://` deep-link URL into a typed result.
 *
 * Supported shapes:
 *   openchat://user/<userId>?v=1    → { type: 'user', userId }
 *   openchat://invite/<token>       → { type: 'invite', token }
 *   openchat://card/<token>         → { type: 'card', token }   (AddMe card)
 *   https://chat.globalbr.ai/c/<t>  → { type: 'card', token }
 *   https://chat.globalbr.ai/u/<id> → { type: 'user', userId }   (web fallback)
 *   https://chat.globalbr.ai/app/?intent=add-user&id=<id>
 *   https://chat.globalbr.ai/app/?intent=invite&token=<token>
 *   https://chat.globalbr.ai/app/?intent=card&token=<token>
 *   anything else                   → { type: 'unknown' }
 */

export type ParsedOpenChatUrl =
  | { type: 'user'; userId: string }
  | { type: 'invite'; token: string }
  | { type: 'card'; token: string }
  | { type: 'context'; conversationId: string; entryId: string }
  | { type: 'unknown' };

export function parseOpenChatUrl(raw: string): ParsedOpenChatUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { type: 'unknown' };
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

  // https://chat.globalbr.ai/u/<userId>  (web fallback link)
  // https://chat.globalbr.ai/i/<token>   (group invite web link)
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (url.hostname === 'chat.globalbr.ai' || url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    const userMatch = url.pathname.match(/^\/u\/(.+)$/);
    if (userMatch?.[1]) return { type: 'user', userId: userMatch[1] };

    const inviteMatch = url.pathname.match(/^\/i\/(.+)$/);
    if (inviteMatch?.[1]) return { type: 'invite', token: inviteMatch[1] };

    const cardMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (cardMatch?.[1]) return { type: 'card', token: cardMatch[1] };

    const contextMatch = url.pathname.match(/^\/app\/context\/([^\/]+)\/([^\/]+)$/);
    if (contextMatch?.[1] && contextMatch?.[2]) return { type: 'context', conversationId: contextMatch[1], entryId: contextMatch[2] };

    // The responsive web client lives at /app/. Server-rendered public pages
    // carry their post-auth destination in the query so OAuth can always
    // return to the one registered /app/ callback.
    if (/^\/app\/?$/.test(url.pathname)) {
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
