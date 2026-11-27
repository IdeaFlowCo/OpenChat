/**
 * Client-supplied message ids (openchat-dkv).
 *
 * A client sends a stable id with a message so that a send retried after a lost
 * acknowledgement (socket, then the REST fallback) collapses to one row. The id
 * is only ever an idempotency key for the SAME sender in the SAME conversation:
 * it must never address someone else's message.
 */

/** Ids derived on the server (connector and delegated sends) and client-only placeholders. */
const RESERVED_PREFIXES = ['ocd_', 'ocu_', 'local-'];
// Short ids stay valid: API and agent callers have always been free to choose their own retry keys.
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type ClientMessageId =
  | { ok: true; id: string | null }
  | { ok: false; error: string };

/**
 * Absent or empty: the server assigns the id. Otherwise a URL-safe token of at
 * most 64 characters (a UUID, a nanoid, a caller's own key) outside the
 * server's own id namespaces. The shape is hygiene; what protects other
 * people's messages is MESSAGE_ID_BELONGS_TO_SEND.
 */
export function parseClientMessageId(value: unknown): ClientMessageId {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  if (typeof value !== 'string' || !CLIENT_MESSAGE_ID.test(value) || RESERVED_PREFIXES.some(prefix => value.startsWith(prefix))) {
    return { ok: false, error: 'Message id must be 1 to 64 letters, digits, hyphens or underscores' };
  }
  return { ok: true, id: value };
}

/**
 * Cypher predicate placed right after `MERGE (m:Message {id: $id}) ON CREATE SET …`.
 * A freshly created row passes. An existing row passes only when it is this
 * sender's message in this conversation (a retry). Anything else yields no row,
 * so nothing is linked, changed, returned or broadcast.
 */
export const MESSAGE_ID_BELONGS_TO_SEND = 'm.senderId = $senderId AND m.conversationId = $conversationId';
export const MESSAGE_ID_IN_USE = 'Message id already in use';
