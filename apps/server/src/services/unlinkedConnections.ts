import { createHash } from 'node:crypto';
import { getDriver } from '../db.js';
import { ensureSharedInboxInTransaction } from './unlinkedMessaging.js';
import { acquireContextAclLocks } from './contextAccess.js';
import { ensureDirectConversationInTransaction } from './directConversation.js';

const ISSUER = 'https://id.ideaflow.app/api/auth';
type Member = { issuer: string; subject: string; name: string };
export type AcceptedUnlinkedConnection = { requestId: string; acceptedAt: number; sender: Member; recipient: Member };
export class UnlinkedConnectionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function parseAcceptedConnection(input: unknown): AcceptedUnlinkedConnection {
  const value = input as AcceptedUnlinkedConnection;
  const member = (v: Member) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every(k => ['issuer', 'subject', 'name'].includes(k))
    && v.issuer === ISSUER && typeof v.subject === 'string' && v.subject.length > 0 && v.subject.length <= 512
    && !Array.from(v.subject).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    && typeof v.name === 'string' && v.name.length <= 160;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['requestId', 'acceptedAt', 'sender', 'recipient'].includes(k))
    || typeof value.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.requestId)
    || !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt <= 0
    || !member(value.sender) || !member(value.recipient) || value.sender.subject === value.recipient.subject) {
    throw new UnlinkedConnectionError(400, 'invalid_connection');
  }
  return value;
}

/** No message, push, friendship ACL or agent notification is created here. */
export async function syncAcceptedUnlinkedConnection(input: AcceptedUnlinkedConnection): Promise<{ status: 'synced' | 'suppressed'; conversationId: string | null }> {
  const value = parseAcceptedConnection(input);
  const binding = createHash('sha256').update(JSON.stringify([value.sender.issuer, value.sender.subject, value.recipient.subject, value.acceptedAt])).digest('hex');
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      // Immutable identities in a deterministic order; no email/name matching.
      const members = [value.sender, value.recipient].sort((a, b) => a.subject < b.subject ? -1 : 1);
      const first = await ensureSharedInboxInTransaction(tx, members[0], members[0].name);
      const second = await ensureSharedInboxInTransaction(tx, members[1], members[1].name);
      await acquireContextAclLocks(tx, { userIds: [first.id, second.id] });
      const receipt = await tx.run(`MERGE (r:UnlinkedConnectionSync {requestId:$requestId})
        ON CREATE SET r.binding=$binding,r.createdAt=datetime()
        SET r.lockVersion=coalesce(r.lockVersion,0)+1
        RETURN r.binding AS binding,r.status AS status,r.conversationId AS conversationId`, { requestId: value.requestId, binding });
      const record = receipt.records[0];
      if (record.get('binding') !== binding) throw new UnlinkedConnectionError(409, 'connection_identity_conflict');
      if (record.get('status')) return { status: record.get('status'), conversationId: record.get('conversationId') };
      const permission = await tx.run(`MATCH (a:User {id:$first}),(b:User {id:$second})
        OPTIONAL MATCH (connection:OpenChatConnection {pairKey:$pairKey})
        RETURN (a)-[:BLOCKED]->(b) OR (b)-[:BLOCKED]->(a)
          OR coalesce(a.isBot,false) OR coalesce(b.isBot,false)
          OR coalesce(connection.state IN ['removed','declined'],false) AS suppressed`,
      { first: first.id, second: second.id, pairKey: JSON.stringify([first.id, second.id].sort()) });
      const suppressed = permission.records[0]?.get('suppressed') !== false;
      const conversationId = suppressed ? null : (await ensureDirectConversationInTransaction(tx, first.id, second.id)).conversation.id as string;
      const status = suppressed ? 'suppressed' : 'synced';
      await tx.run(`MATCH (r:UnlinkedConnectionSync {requestId:$requestId})
        SET r.status=$status,r.conversationId=$conversationId,r.completedAt=datetime()`, { requestId: value.requestId, status, conversationId });
      return { status, conversationId };
    });
  } finally { await session.close(); }
}
