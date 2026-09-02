import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { joinUserSocketsToConversation } from '../websocket/chatHandler.js';

export interface DirectConversationResult {
  conversation: Record<string, unknown>;
  created: boolean;
}

function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in value && 'year' in value) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJS(item)]));
  }
  return value;
}

function notifyParticipants(
  io: IOServer | undefined,
  conversation: Record<string, unknown>,
  participantIds: string[],
  created: boolean,
): void {
  if (!io) return;
  const conversationId = conversation.id as string;
  for (const participantId of participantIds) {
    joinUserSocketsToConversation(io, participantId, conversationId);
    if (created) {
      io.to(`user:${participantId}`).emit('conversation:created', {
        conversationId,
        conversation,
      });
    }
  }
}

/**
 * Return the one exact direct conversation for two users, or create it.
 * This is the canonical DM dedup path used by both the public chat route and
 * agent-network connections. A self-DM has one participant edge; a human DM
 * has exactly two.
 */
export async function ensureDirectConversation(
  userId: string,
  otherId: string,
  io?: IOServer,
  title?: string,
): Promise<DirectConversationResult> {
  const session = getDriver().session();
  try {
    const id = nanoid();
    const now = new Date().toISOString();
    const participantIds = [...new Set([userId, otherId])].sort();
    const directPairKey = JSON.stringify(participantIds);
    const creationToken = nanoid();
    const result = await session.run(
      `
      MATCH (first:User {id: $firstId}), (second:User {id: $secondId})
      OPTIONAL MATCH (first)-[:PARTICIPATES_IN]->(existing:Conversation {type: 'direct'})
      WHERE ($firstId = $secondId AND NOT EXISTS {
        MATCH (other:User)-[:PARTICIPATES_IN]->(existing)
        WHERE other.id <> $firstId
      }) OR ($firstId <> $secondId
        AND EXISTS { MATCH (second)-[:PARTICIPATES_IN]->(existing) }
        AND NOT EXISTS {
          MATCH (other:User)-[:PARTICIPATES_IN]->(existing)
          WHERE NOT other.id IN [$firstId, $secondId]
        })
      WITH first, second, head(collect(existing)) AS existing
      FOREACH (_ IN CASE WHEN existing IS NULL THEN [] ELSE [1] END |
        SET existing.directPairKey = $directPairKey
      )
      MERGE (c:Conversation {directPairKey: $directPairKey})
      ON CREATE SET c.id = $id, c.title = $title, c.type = 'direct',
                    c.containsBot = coalesce(first.isBot, false) OR coalesce(second.isBot, false),
                    c.createdAt = datetime($now),
                    c.updatedAt = datetime($now), c.lastMessageAt = datetime($now),
                    c.creationToken = $creationToken
      WITH c, c.creationToken = $creationToken AS created
      REMOVE c.creationToken
      UNWIND $participantIds AS participantId
      MATCH (user:User {id: participantId})
      MERGE (user)-[rel:PARTICIPATES_IN]->(c)
      ON CREATE SET rel.joinedAt = datetime($now),
                    rel.role = CASE WHEN participantId = $userId THEN 'owner' ELSE 'member' END
      WITH c, created,
           collect({user: user {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
      RETURN c { .*, participants: participants } AS conversation, created
      `,
      {
        id,
        now,
        participantIds,
        userId,
        firstId: participantIds[0],
        secondId: participantIds.at(-1),
        directPairKey,
        creationToken,
        title: title || null,
      },
    );
    if (result.records.length === 0) throw new Error('Direct conversation participants not found');

    const conversation = toJS(result.records[0].get('conversation')) as Record<string, unknown>;
    const created = result.records[0].get('created') as boolean;
    notifyParticipants(io, conversation, participantIds, created);
    return { conversation, created };
  } finally {
    await session.close();
  }
}
