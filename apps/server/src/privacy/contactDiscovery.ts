const SELF_QUERIES = new Set(['me', 'self', 'myself']);

export type ContactDiscoveryQuery =
  | { kind: 'self'; normalized: string }
  | { kind: 'email'; normalized: string }
  | { kind: 'invalid'; normalized: string };

/**
 * Contact discovery intentionally does not support directory browsing or
 * partial matches. A caller may always find themselves, while another account
 * is discoverable only when the caller supplies a complete email address.
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

  return looksLikeCompleteEmail
    ? { kind: 'email', normalized }
    : { kind: 'invalid', normalized };
}
