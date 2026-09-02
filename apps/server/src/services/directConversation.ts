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
 * has exactly two. Newly created conversations are explicitly non-bot DMs.
 */
export async function ensureDirectConversation(
  userId: string,
  otherId: string,
  io?: IOServer,
): Promise<DirectConversationResult> {
  const session = getDriver().session();
  try {
    const existing = await session.run(
      `
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      WHERE c.type = 'direct'
      WITH c,
           collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
      WITH c, participants, [p IN participants | p.user.id] AS participantIds
      WHERE (
        $otherId = $userId
        AND size(participantIds) = 1
        AND $userId IN participantIds
      ) OR (
        $otherId <> $userId
        AND size(participantIds) = 2
        AND $userId IN participantIds
        AND $otherId IN participantIds
      )
      RETURN c { .*, participants: participants } AS conversation
      LIMIT 1
      `,
      { userId, otherId },
    );

    if (existing.records.length > 0) {
      const conversation = toJS(existing.records[0].get('conversation')) as Record<string, unknown>;
      notifyParticipants(io, conversation, [...new Set([userId, otherId])], false);
      return { conversation, created: false };
    }

    const id = nanoid();
    const now = new Date().toISOString();
    const participantIds = [...new Set([userId, otherId])];
    const created = await session.run(
      `
      CREATE (c:Conversation {
        id: $id, title: null, type: 'direct', containsBot: false,
        createdAt: datetime($now), updatedAt: datetime($now), lastMessageAt: datetime($now)
      })
      WITH c
      UNWIND $participantIds AS participantId
      MATCH (user:User {id: participantId})
      CREATE (user)-[rel:PARTICIPATES_IN {
        joinedAt: datetime($now),
        role: CASE WHEN participantId = $userId THEN 'owner' ELSE 'member' END
      }]->(c)
      WITH c, collect({user: user {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
      RETURN c { .*, participants: participants } AS conversation
      `,
      { id, now, participantIds, userId },
    );
    if (created.records.length === 0) throw new Error('Direct conversation participants not found');

    const conversation = toJS(created.records[0].get('conversation')) as Record<string, unknown>;
    notifyParticipants(io, conversation, participantIds, true);
    return { conversation, created: true };
  } finally {
    await session.close();
  }
}
