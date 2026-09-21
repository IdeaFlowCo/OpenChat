import { Session } from 'neo4j-driver';
import { nanoid } from 'nanoid';

export type EntryTarget =
  | { kind: 'group'; token: string }
  | { kind: 'person'; userId: string };

export type PendingEntry = {
  id: string;
  clientIntentId: string;
  target: EntryTarget;
  continuation: string;
  status: 'pending' | 'completed' | 'dismissed';
  createdAt: string;
  expiresAt: string;
};

export async function savePendingEntry(
  session: Session,
  userId: string,
  clientIntentId: string,
  target: EntryTarget,
  continuation: string
): Promise<{ id: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const id = nanoid();

  await session.run(`
    MATCH (u:User {id: $userId})
    MERGE (u)-[r:HAS_PENDING_ENTRY {clientIntentId: $clientIntentId}]->(pe:PendingEntry)
    ON CREATE SET pe.id = $id, pe.targetKind = $targetKind, pe.targetValue = $targetValue,
                  pe.continuation = $continuation, pe.status = 'pending',
                  pe.createdAt = datetime($now), pe.expiresAt = datetime($expiresAt)
    ON MATCH SET pe.targetKind = $targetKind, pe.targetValue = $targetValue,
                 pe.continuation = $continuation, pe.status = 'pending',
                 pe.expiresAt = datetime($expiresAt)
  `, {
    userId, clientIntentId, id, targetKind: target.kind, targetValue: target.kind === 'group' ? (target as any).token : (target as any).userId,
    continuation, now: now.toISOString(), expiresAt
  });

  return { id };
}

export async function listPendingEntries(session: Session, userId: string): Promise<PendingEntry[]> {
  const result = await session.run(`
    MATCH (u:User {id: $userId})-[:HAS_PENDING_ENTRY]->(pe:PendingEntry)
    WHERE pe.status = 'pending' AND pe.expiresAt > datetime()
    RETURN pe { .id, .clientIntentId, .targetKind, .targetValue, .continuation, .status, .createdAt, .expiresAt } AS entry
    ORDER BY pe.createdAt DESC LIMIT 10
  `, { userId });

  return result.records.map(r => {
    const e = r.get('entry');
    return {
      id: e.id,
      clientIntentId: e.clientIntentId,
      target: e.targetKind === 'group' ? { kind: 'group', token: e.targetValue } : { kind: 'person', userId: e.targetValue },
      continuation: e.continuation,
      status: e.status,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
    };
  });
}

export async function completePendingEntry(session: Session, userId: string, id: string): Promise<void> {
  await session.run(`
    MATCH (u:User {id: $userId})-[:HAS_PENDING_ENTRY]->(pe:PendingEntry {id: $id})
    SET pe.status = 'completed', pe.completedAt = datetime()
  `, { userId, id });
}

export async function dismissPendingEntry(session: Session, userId: string, id: string): Promise<void> {
  await session.run(`
    MATCH (u:User {id: $userId})-[:HAS_PENDING_ENTRY]->(pe:PendingEntry {id: $id})
    SET pe.status = 'dismissed'
  `, { userId, id });
}