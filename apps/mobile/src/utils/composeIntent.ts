/** Profile URLs are context only; never an OpenChat identity proof. */
export type ComposeIntent = { source: 'unlinked'; profile?: string; card?: string };
export function canonicalPublicUnlinkedProfile(value: string): string | null {
  const match = /^https:\/\/www\.unlinked\.ai(\/people\/([A-Za-z0-9._~%-]{1,480})\/?)$/.exec(value);
  if (!match || value.length > 600) return null;
  try {
    const decoded = decodeURIComponent(match[2]);
    if (decoded === '.' || decoded === '..' || /[\/?#\\\s\x00-\x1f]/.test(decoded)) return null;
    const url = new URL(value);
    return url.pathname === match[1] ? value : null;
  } catch { return null; }
}
export function parseComposeIntent(url: URL): ComposeIntent | null {
  if (url.searchParams.get('intent') !== 'compose' || url.searchParams.get('source') !== 'unlinked') return null;
  if ([...url.searchParams.keys()].some(key => !['intent', 'source', 'profile', 'card', 'embed'].includes(key))) return null;
  if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return null;
  // Unlinked's iframe adds a presentation flag; it is not recipient authority.
  if (url.searchParams.has('embed') && url.searchParams.get('embed') !== 'unlinked') return null;
  const profile = url.searchParams.get('profile');
  const card = url.searchParams.get('card');
  if (profile !== null && !canonicalPublicUnlinkedProfile(profile)) return null;
  if (card !== null && !/^[A-Za-z0-9]{24}$/.test(card)) return null;
  return { source: 'unlinked', ...(profile ? { profile } : {}), ...(card ? { card } : {}) };
}
