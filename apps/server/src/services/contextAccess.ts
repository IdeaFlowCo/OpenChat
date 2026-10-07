import { ManagedTransaction } from 'neo4j-driver';

/**
 * Acquires a write lock on the specified User, Conversation, and AgentKey nodes
 * in a strict order to prevent deadlocks:
 * 1. User nodes (sorted by ID)
 * 2. Conversation node
 * 3. AgentKey node
 *
 * It increments a `contextAclRevision` property on each node to ensure the
 * transaction acquires a write lock in Neo4j.
 */
export async function acquireContextAclLocks(
  tx: ManagedTransaction,
  opts: {
    userIds?: string[];
    conversationId?: string;
    agentKeyId?: string;
  }
): Promise<void> {
  // 1. Lock Users in sorted order
  if (opts.userIds && opts.userIds.length > 0) {
    const sortedUsers = [...new Set(opts.userIds)].sort();
    for (const userId of sortedUsers) {
      await tx.run(
        `MATCH (u:User {id: $userId})
         SET u.contextAclRevision = coalesce(u.contextAclRevision, 0) + 1`,
        { userId }
      );
    }
  }

  // 2. Lock Conversation
  if (opts.conversationId) {
    await tx.run(
      `MATCH (c:Conversation {id: $conversationId})
       SET c.contextAclRevision = coalesce(c.contextAclRevision, 0) + 1`,
      { conversationId: opts.conversationId }
    );
  }

  // 3. Lock AgentKey
  if (opts.agentKeyId) {
    await tx.run(
      `MATCH (k:AgentKey {id: $agentKeyId})
       SET k.contextAclRevision = coalesce(k.contextAclRevision, 0) + 1`,
      { agentKeyId: opts.agentKeyId }
    );
  }
}

/** Context shares the owning user's conversation membership and read/write key scopes.
 * Recheck the persisted key so cached authentication cannot outlive revocation,
 * expiry, or a scope change. Mutations call this after acquiring the ACL locks.
 */
async function checkContextAccess(
  tx: ManagedTransaction,
  userId: string,
  conversationId: string,
  scope: 'read' | 'write',
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<boolean> {
  if (agentKeyId && !agentScopes?.includes(scope)) return false;
  const result = await tx.run(
    `MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
     ${agentKeyId ? `MATCH (k:AgentKey {id: $agentKeyId, ownerUserId: $userId})
     WHERE k.revokedAt IS NULL
       AND (k.expiresAt IS NULL OR k.expiresAt > $now)
       AND $scope IN coalesce(k.scopes, [])` : ''}
     RETURN c.id AS conversationId`,
    { userId, conversationId, agentKeyId: agentKeyId ?? null, scope, now: new Date().toISOString() }
  );
  return result.records.length > 0;
}

export async function checkContextReadAccess(
  tx: ManagedTransaction, userId: string, conversationId: string,
  agentKeyId?: string, agentScopes?: string[]
): Promise<boolean> {
  return checkContextAccess(tx, userId, conversationId, 'read', agentKeyId, agentScopes);
}

export async function checkContextWriteAccess(
  tx: ManagedTransaction, userId: string, conversationId: string,
  agentKeyId?: string, agentScopes?: string[]
): Promise<boolean> {
  return checkContextAccess(tx, userId, conversationId, 'write', agentKeyId, agentScopes);
}
