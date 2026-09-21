import { Session } from 'neo4j-driver';

// Helper to convert Neo4j types to JS
function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in (value as object) && 'year' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      result[k] = toJS(v);
    }
    return result;
  }
  return value;
}

export type InvitePreview = {
  conversationId: string;
  conversationTitle: string | null;
  memberCount: number;
  expiresAt: string;
};

export class InviteError extends Error {
  constructor(public message: string, public status: number) {
    super(message);
  }
}

export async function resolveInvitePreview(session: Session, token: string): Promise<InvitePreview> {
  const result = await session.run(`
    MATCH (c:Conversation)-[:HAS_INVITE]->(inv:GroupInvite {token: $token})
    RETURN inv, c.id AS conversationId, c.title AS conversationTitle
  `, { token });

  if (result.records.length === 0) {
    throw new InviteError('Invite not found', 404);
  }

  const rec = result.records[0];
  const inv = toJS(rec.get('inv').properties) as Record<string, unknown>;
  const conversationId = rec.get('conversationId') as string;
  const conversationTitle = rec.get('conversationTitle') as string | null;

  if (inv.revokedAt) {
    throw new InviteError('This invite has been revoked', 410);
  }
  const usesLeft = typeof inv.usesLeft === 'number' ? inv.usesLeft : 0;
  if (usesLeft <= 0) {
    throw new InviteError('This invite has reached its maximum uses', 410);
  }
  const expiresAt = inv.expiresAt as string;
  if (new Date(expiresAt) < new Date()) {
    throw new InviteError('This invite has expired', 410);
  }

  // Get member count (no PII)
  const countResult = await session.run(`
    MATCH (:User)-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
    RETURN count(*) AS memberCount
  `, { conversationId });
  const memberCount = countResult.records[0]?.get('memberCount')?.toNumber?.() ?? 0;

  return {
    conversationId,
    conversationTitle,
    memberCount,
    expiresAt,
  };
}

export type AcceptInviteResult = {
  conversationId: string;
  newlyJoined: boolean;
};

export async function acceptInviteTransaction(session: Session, userId: string, token: string): Promise<AcceptInviteResult> {
  // In one Neo4j executeWrite transaction, lock the conversation then invite in a consistent order, reread membership and availability against server time, return existing membership if present, otherwise verify usable invite, create membership and decrement exactly once. Locking the conversation also serializes the same person's joins through different invite tokens.
  const now = new Date().toISOString();

  const result = await session.executeWrite(async (tx) => {
    // Lock the conversation by doing a dummy SET updatedAt
    const lockResult = await tx.run(`
      MATCH (c:Conversation)-[:HAS_INVITE]->(inv:GroupInvite {token: $token})
      SET c.updatedAt = datetime($now)
      RETURN c.id AS conversationId, inv
    `, { token, now });

    if (lockResult.records.length === 0) {
      throw new InviteError('Invite not found', 404);
    }
    const conversationId = lockResult.records[0].get('conversationId') as string;
    const inv = toJS(lockResult.records[0].get('inv').properties) as Record<string, unknown>;

    // reread membership
    const alreadyIn = await tx.run(`
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      RETURN c.id
    `, { userId, conversationId });

    if (alreadyIn.records.length > 0) {
      return { conversationId, newlyJoined: false };
    }

    if (inv.revokedAt) {
      throw new InviteError('This invite has been revoked', 410);
    }
    const usesLeft = typeof inv.usesLeft === 'number' ? inv.usesLeft : 0;
    if (usesLeft <= 0) {
      throw new InviteError('This invite has reached its maximum uses', 410);
    }
    const expiresAt = inv.expiresAt as string;
    if (new Date(expiresAt) < new Date()) {
      throw new InviteError('This invite has expired', 410);
    }

    // Add the user
    await tx.run(`
      MATCH (c:Conversation {id: $conversationId})
      MATCH (u:User {id: $userId})
      MERGE (u)-[rel:PARTICIPATES_IN]->(c)
        ON CREATE SET rel.joinedAt = datetime($now), rel.role = 'member'
    `, { conversationId, userId, now });

    // Decrement usesLeft on the invite
    await tx.run(`
      MATCH (inv:GroupInvite {token: $token})
      SET inv.usesLeft = inv.usesLeft - 1
    `, { token });

    return { conversationId, newlyJoined: true };
  });

  return result;
}
