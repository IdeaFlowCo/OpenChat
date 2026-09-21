const SELF_QUERIES = new Set(['me', 'self', 'myself']);

export type ContactDiscoveryQuery =
  | { kind: 'empty'; normalized: '' }
  | { kind: 'directory'; normalized: '' }
  | { kind: 'self'; normalized: string }
  | { kind: 'email'; normalized: string }
  | { kind: 'name'; normalized: string }
  | { kind: 'invalid'; normalized: string };

/**
 * Classifies a people-discovery query without ever treating an email fragment
 * as a name search. Complete emails remain exact-match only; ordinary text is
 * a display-name query. Single-character queries are rejected. An empty query
 * becomes a directory request only when the server feature flag is enabled;
 * otherwise callers must provide a query.
 */
export function classifyContactDiscoveryQuery(
  raw: unknown,
  options: { openUserDirectory?: boolean } = {},
): ContactDiscoveryQuery {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  if (normalized === '') {
    return options.openUserDirectory
      ? { kind: 'directory', normalized }
      : { kind: 'empty', normalized };
  }
  if (SELF_QUERIES.has(normalized)) return { kind: 'self', normalized };

  // This is deliberately a conservative shape check rather than full RFC 5322
  // validation. Authentication owns canonical email validation; discovery only
  // needs to distinguish a complete address from an enumerable substring.
  const looksLikeCompleteEmail = normalized.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);

  if (looksLikeCompleteEmail) return { kind: 'email', normalized };
  if (normalized.length >= 2 && !normalized.includes('@')) {
    return { kind: 'name', normalized };
  }
  return { kind: 'invalid', normalized };
}
