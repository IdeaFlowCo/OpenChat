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

/**
 * Verifies that the actor has permission to read the Context lane of a conversation.
 * If the actor is an agent, verifies the agent has the correct scope and delegation.
 * This is the read-only check (does not lock).
 */
export async function checkContextReadAccess(
  tx: ManagedTransaction,
  userId: string,
  conversationId: string,
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<boolean> {
  const membershipResult = await tx.run(
    `MATCH (u:User {id: $userId})-[p:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
     RETURN p`,
    { userId, conversationId }
  );

  if (membershipResult.records.length === 0) {
    return false;
  }

  if (agentKeyId) {
    if (!agentScopes || !agentScopes.includes('read')) {
      return false;
    }
    // Check if user has explicitly granted context access to this agent for this conversation
    const delegationResult = await tx.run(
      `MATCH (u:User {id: $userId})-[g:GRANTS_CONTEXT_ACCESS]->(k:AgentKey {id: $agentKeyId})
       WHERE g.conversationId = $conversationId OR g.conversationId IS NULL
       RETURN g`,
      { userId, agentKeyId, conversationId }
    );
    if (delegationResult.records.length === 0) {
      return false;
    }
  }

  return true;
}

export async function checkContextWriteAccess(
  tx: ManagedTransaction,
  userId: string,
  conversationId: string,
  agentKeyId?: string,
  agentScopes?: string[]
): Promise<boolean> {
  const membershipResult = await tx.run(
    `MATCH (u:User {id: $userId})-[p:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
     RETURN p`,
    { userId, conversationId }
  );

  if (membershipResult.records.length === 0) {
    return false;
  }

  if (agentKeyId) {
    if (!agentScopes || !agentScopes.includes('write')) {
      return false;
    }
    const delegationResult = await tx.run(
      `MATCH (u:User {id: $userId})-[g:GRANTS_CONTEXT_ACCESS]->(k:AgentKey {id: $agentKeyId})
       WHERE g.conversationId = $conversationId OR g.conversationId IS NULL
       RETURN g`,
      { userId, agentKeyId, conversationId }
    );
    if (delegationResult.records.length === 0) {
      return false;
    }
  }

  return true;
}