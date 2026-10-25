import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { acquireContextAclLocks } from './contextAccess.js';
import { ensureDirectConversationInTransaction } from './directConversation.js';
import { legacyEmailProjection } from '../privacy/legacyEmailCompat.js';

export class ConnectorTextSendError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_request' | 'request_conflict' | 'destination_changed') {
    super(code);
  }
}
export type ConnectorTextTarget = { kind: 'person'; id: string } | { kind: 'conversation'; id: string };
export interface ConnectorTextInput {
  actorId: string;
  target: ConnectorTextTarget;
  requestId: string;
  content: string;
  replyToId?: string;
  // Provenance only, never a deduplication namespace or authority.
  connectorLabel?: string;
}
export interface ConnectorTextReceipt {
  accepted: true;
  messageId: string;
  conversationId: string;
  recipientId: string | null;
  replayed: boolean;
}
export interface ConnectorTextResult {
  receipt: ConnectorTextReceipt;
  message?: Record<string, unknown>;
  participantIds: string[];
  createdDirect?: { conversation: Record<string, unknown>; created: boolean };
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasControl = (value: string): boolean => Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const invalid = (): never => { throw new ConnectorTextSendError('invalid_request'); };
const unavailable = (): never => { throw new ConnectorTextSendError('unavailable'); };

// Same known/connection/name-discovery policy as peopleSuggestions. A saved ID
// cannot retain a previously supplied exact-email discovery proof. Never create
// an empty DM to turn an otherwise unavailable person into a known contact.
export const PERSON_SEND_ELIGIBILITY = `
  MATCH (actor:User {id:$actorId}), (person:User {id:$personId})
  WHERE actor.id <> person.id AND NOT coalesce(person.isBot, false)
    AND NOT (actor)-[:BLOCKED]-(person)
  WITH actor, person,
    EXISTS { (actor)-[:PARTICIPATES_IN]->(:Conversation)<-[:PARTICIPATES_IN]-(person) } AS known,
    EXISTS { MATCH (connection:OpenChatConnection)
      WHERE connection.state = 'accepted' AND connection.pairKey = $pairKey } AS connected
  WHERE known OR connected OR (coalesce(person.discoveryMode, 'name') = 'name'
    AND NOT coalesce(person.name, '') CONTAINS '@')
  RETURN person.id AS id
`;

async function participants(tx: Pick<ManagedTransaction, 'run'>, actorId: string, conversationId: string): Promise<string[]> {
  const result = await tx.run(`
    MATCH (actor:User {id:$actorId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
    MATCH (person:User)-[:PARTICIPATES_IN]->(c)
    RETURN collect(DISTINCT person.id) AS ids`, { actorId, conversationId });
  return result.records.length ? (result.records[0].get('ids') as string[]).sort() : [];
}

/** Trusted connector callers only. Receipt identity is actor+nonce, independent
 * of refresh tokens, grants, labels, and mutable/deleted messages. The caller
 * authenticates the exact operation before invoking this internal service. */
export async function sendConnectorText(input: ConnectorTextInput): Promise<ConnectorTextResult> {
  const { actorId, target, requestId, content, replyToId } = input;
  if (!actorId || !target || !['person', 'conversation'].includes(target.kind)
    || typeof target.id !== 'string' || !target.id || target.id.length > 200
    || hasControl(target.id)
    || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200 || hasControl(requestId)
    || typeof content !== 'string' || !content.trim() || content.length > 20000
    || (replyToId !== undefined && (typeof replyToId !== 'string' || !replyToId || replyToId.length > 200))
    || (target.kind === 'person' && !/^[A-Za-z0-9_-]{1,80}$/.test(target.id))) invalid();
  const receiptId = hash([actorId, requestId]);
  const signature = hash([actorId, target.kind, target.id, content, replyToId ?? null]);
  const session = getDriver().session();
  try {
    // Read only IDs to establish lock order. The transaction rechecks the exact
    // membership set after taking the same ACL locks as block/leave mutations.
    const initialIds = target.kind === 'person' ? [actorId, target.id].sort()
      : await participants(session, actorId, target.id);
    return await session.executeWrite(async tx => {
      // Actor lock serializes all of this actor's nonces, including a conflicting
      // request that names a different destination. Always lock in global order.
      await acquireContextAclLocks(tx, { userIds: [...initialIds, actorId],
        ...(target.kind === 'conversation' ? { conversationId: target.id } : {}) });
      const actor = await tx.run('MATCH (u:User {id:$actorId}) RETURN u.id AS id', { actorId });
      if (actor.records.length !== 1) unavailable();
      const known = await tx.run('MATCH (r:ConnectorTextReceipt {id:$receiptId, ownerUserId:$actorId}) RETURN r { .* } AS receipt', { receiptId, actorId });
      if (known.records.length) {
        const saved = known.records[0].get('receipt') as Record<string, unknown>;
        if (saved.requestHash !== signature) throw new ConnectorTextSendError('request_conflict');
        // Historical acceptance precedes today's admission. No content read,
        // conversation recreation, permission change or delivery effect.
        return { receipt: { accepted: true, messageId: saved.messageId as string,
          conversationId: saved.conversationId as string,
          recipientId: saved.recipientId as string | null ?? null, replayed: true }, participantIds: [] };
      }
      let conversationId = target.id;
      let ids = initialIds;
      let createdDirect: ConnectorTextResult['createdDirect'];
      if (target.kind === 'person') {
        const eligible = await tx.run(PERSON_SEND_ELIGIBILITY, { actorId, personId: target.id,
          pairKey: JSON.stringify([actorId, target.id].sort()) });
        if (eligible.records.length !== 1) unavailable();
        createdDirect = await ensureDirectConversationInTransaction(tx, actorId, target.id);
        conversationId = createdDirect.conversation.id as string;
      } else {
        const currentIds = await participants(tx, actorId, conversationId);
        if (!currentIds.length) unavailable();
        if (JSON.stringify(currentIds) !== JSON.stringify(initialIds)) throw new ConnectorTextSendError('destination_changed');
        ids = currentIds;
      }
      const allowed = await tx.run(`
        MATCH (actor:User {id:$actorId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
        WHERE NOT EXISTS { MATCH (person:User)-[:PARTICIPATES_IN]->(c)
          WHERE person.id <> actor.id AND (actor)-[:BLOCKED]-(person) }
        RETURN c.id AS id`, { actorId, conversationId });
      if (!allowed.records.length) unavailable();
      if (replyToId) {
        const reply = await tx.run('MATCH (m:Message {id:$replyToId, conversationId:$conversationId}) RETURN m.id AS id', { replyToId, conversationId });
        if (!reply.records.length) invalid();
      }
      const messageId = nanoid();
      const now = new Date().toISOString();
      const result = await tx.run(`
        MATCH (sender:User {id:$actorId}), (c:Conversation {id:$conversationId})
        CREATE (m:Message {id:$messageId, senderId:$actorId, conversationId:$conversationId,
          content:$content, messageType:'text', createdAt:datetime($now),
          connectorAgentId:'ideaflow-connector', agentName:$connectorAgentName})
        SET m.replyToId = $replyToId
        CREATE (sender)-[:SENT]->(m), (m)-[:IN_CONVERSATION]->(c)
        SET c.updatedAt=datetime($now), c.lastMessageAt=datetime($now), c.lastMessagePreview=left($content,100)
        CREATE (r:ConnectorTextReceipt {id:$receiptId, ownerUserId:$actorId,
          requestHash:$signature, messageId:$messageId, conversationId:$conversationId, createdAt:datetime($now)})
        SET r.recipientId=$recipientId
        CREATE (sender)-[:HAS_CONNECTOR_TEXT_RECEIPT]->(r)
        WITH m, sender
        OPTIONAL MATCH (reply:Message {id:$replyToId})
        OPTIONAL MATCH (replySender:User {id:reply.senderId})
        RETURN m { .*, replyTo: CASE WHEN reply IS NULL THEN null ELSE {id:reply.id,content:left(reply.content,200),senderId:reply.senderId,senderName:replySender.name,messageType:reply.messageType} END, sender: sender { .id, .name, .avatarUrl, ${legacyEmailProjection('sender')} } } AS message`, {
        actorId, conversationId, messageId, content, replyToId: replyToId ?? null,
        connectorAgentName: input.connectorLabel?.trim().slice(0, 100) || 'Ideaflow connector',
        now, receiptId, signature, recipientId: target.kind === 'person' ? target.id : null,
      });
      if (result.records.length !== 1) throw new Error('connector_text_persistence_failed');
      const message = result.records[0].get('message') as Record<string, unknown>;
      message.createdAt = now;
      return { receipt: { accepted: true, messageId, conversationId,
        recipientId: target.kind === 'person' ? target.id : null, replayed: false },
      message, participantIds: [...new Set(ids)], createdDirect };
    });
  } finally { await session.close(); }
}
