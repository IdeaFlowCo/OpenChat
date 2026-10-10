/**
 * New message ranking on the client (audit P0-2, OpenChat-eo3n.2). Recent and
 * Friends come from data the app already holds, so they appear instantly and
 * filter without waiting for the debounced directory search; the server's
 * directory results (already recent-first, PR #166) follow as Everyone.
 */
import type { Conversation, User } from '../api/client';

export const RECENT_LIMIT = 8;

/** 0 = a name word starts with the query, 1 = the name contains it, null = no match. */
export function matchRank(name: string | undefined, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = (name ?? '').toLowerCase();
  if (!n) return null;
  if (n.startsWith(q) || n.split(/\s+/).some(word => word.startsWith(q))) return 0;
  return n.includes(q) ? 1 : null;
}

function filterRanked(users: User[], query: string): User[] {
  if (!query.trim()) return users;
  return users
    .map((user, index) => ({ user, index, rank: matchRank(user.name, query) }))
    .filter((row): row is { user: User; index: number; rank: number } => row.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(row => row.user);
}

export interface ComposeSections { recent: User[]; friends: User[]; everyone: User[] }

export function buildComposeSections({ conversations, friends, directory, currentUserId, query }: {
  conversations: Conversation[];
  friends: User[];
  directory: User[];
  currentUserId?: string;
  query: string;
}): ComposeSections {
  const seen = new Set<string>();
  const recentAll: User[] = [];
  const direct = conversations
    .filter(conv => conv.type === 'direct' && conv.lastMessageAt)
    .sort((a, b) => Date.parse(b.lastMessageAt!) - Date.parse(a.lastMessageAt!));
  for (const conv of direct) {
    const other = conv.participants?.find(p => p.user?.id && p.user.id !== currentUserId)?.user;
    if (!other || seen.has(other.id)) continue;
    seen.add(other.id);
    recentAll.push(other);
  }
  const recent = query.trim() ? filterRanked(recentAll, query) : recentAll.slice(0, RECENT_LIMIT);
  const shown = new Set(recent.map(user => user.id));
  const friendRows = filterRanked(
    friends
      .filter(user => !shown.has(user.id) && user.id !== currentUserId)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' })),
    query,
  );
  for (const user of friendRows) shown.add(user.id);
  const everyone = directory.filter(user => !shown.has(user.id));
  return { recent, friends: friendRows, everyone };
}
