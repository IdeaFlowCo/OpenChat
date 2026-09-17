const SELF_QUERIES = new Set(['me', 'self', 'myself']);

export type ContactDiscoveryQuery =
  | { kind: 'self'; normalized: string }
  | { kind: 'email'; normalized: string }
  | { kind: 'name'; normalized: string }
  | { kind: 'invalid'; normalized: string };

/**
 * Classifies a people-discovery query without ever treating an email fragment
 * as a name search. Complete emails remain exact-match only; ordinary text is
 * a display-name query. Single-character queries are rejected to keep the
 * early-beta directory useful without making it trivially enumerable.
 */
export function classifyContactDiscoveryQuery(raw: unknown): ContactDiscoveryQuery {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  if (normalized === '' || SELF_QUERIES.has(normalized)) {
    return { kind: 'self', normalized };
  }

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
