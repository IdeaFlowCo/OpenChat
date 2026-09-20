/**
 * Small in-memory cache for composer hashtag suggestions.
 *
 * Suggestions are advisory, so cache/fetch failures intentionally never
 * escape into the typing path. The screen owns the short debounce while this
 * module deduplicates repeated requests across composer mounts.
 */

import { api, HashtagSuggestion } from '../api/client';

export type { HashtagSuggestion };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: HashtagSuggestion[] }>();
const pending = new Map<string, Promise<HashtagSuggestion[]>>();

function cacheKey(conversationId: string, query: string): string {
  return `${conversationId}:${query.toLowerCase()}`;
}

export async function fetchHashtagSuggestions(
  conversationId: string,
  query: string,
): Promise<HashtagSuggestion[]> {
  const normalizedQuery = query.toLowerCase();
  const key = cacheKey(conversationId, normalizedQuery);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existing = pending.get(key);
  if (existing) return existing;

  const request = api.getHashtagSuggestions(conversationId, normalizedQuery)
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/** Clear one chat after a message send so a newly-created tag can surface. */
export function invalidateHashtagSuggestions(conversationId: string): void {
  const prefix = `${conversationId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
