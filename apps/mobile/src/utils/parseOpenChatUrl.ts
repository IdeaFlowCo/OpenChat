/**
 * parseOpenChatUrl — parses an `openchat://` deep-link URL into a typed result.
 *
 * Supported shapes:
 *   openchat://user/<userId>?v=1    → { type: 'user', userId }
 *   openchat://invite/<token>       → { type: 'invite', token }
 *   https://chat.globalbr.ai/u/<id> → { type: 'user', userId }   (web fallback)
 *   anything else                   → { type: 'unknown' }
 */

export type ParsedOpenChatUrl =
  | { type: 'user'; userId: string }
  | { type: 'invite'; token: string }
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

  // https://chat.globalbr.ai/u/<userId>  (web fallback link)
  // https://chat.globalbr.ai/i/<token>   (group invite web link)
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname === 'chat.globalbr.ai'
  ) {
    const userMatch = url.pathname.match(/^\/u\/(.+)$/);
    if (userMatch?.[1]) return { type: 'user', userId: userMatch[1] };

    const inviteMatch = url.pathname.match(/^\/i\/(.+)$/);
    if (inviteMatch?.[1]) return { type: 'invite', token: inviteMatch[1] };
  }

  return { type: 'unknown' };
}
