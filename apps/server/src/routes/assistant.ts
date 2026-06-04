/**
 * Assistant routes (openchat-bfn.3).
 *
 * POST /api/assistant/ensure — idempotently MERGE a direct conversation
 * between the caller and the singleton Assistant bot (containsBot=true), so
 * clients can open/pin an "Assistant" chat. Returns the conversation.
 */

import { Router, Request, Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { joinUserSocketsToConversation } from '../websocket/chatHandler.js';
import {
  ensureAssistantUser,
  ASSISTANT_USER_ID,
} from '../services/assistant.js';

const router = Router();

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
    for (const [k, v] of Object.entries(value as object)) result[k] = toJS(v);
    return result;
  }
  return value;
}

// POST /api/assistant/ensure
router.post('/ensure', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // The assistant bot must exist (boot does this, but be defensive).
  await ensureAssistantUser();

  const session = getDriver().session();
  try {
    // Find an existing direct conversation between caller + assistant.
    const existing = await session.run(
      `
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {type: 'direct'})
      MATCH (bot:User {id: $assistantId})-[:PARTICIPATES_IN]->(c)
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      WITH c, collect({ user: participant { .id, .name, .email, .isBot }, role: rel.role }) AS participants
      RETURN c { .*, containsBot: true, participants: participants } AS conversation
      LIMIT 1
      `,
      { userId, assistantId: ASSISTANT_USER_ID }
    );

    if (existing.records.length > 0) {
      const conv = toJS(existing.records[0].get('conversation')) as Record<string, unknown> | null;
      const io = req.app.get('io') as IOServer | undefined;
      const convId = typeof conv?.id === 'string' ? conv.id : null;
      if (io && convId) joinUserSocketsToConversation(io, userId, convId);
      res.json(conv);
      return;
    }

    // Create a new direct conversation flagged containsBot=true.
    const conversationId = nanoid();
    const now = new Date().toISOString();
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})
      MATCH (bot:User {id: $assistantId})
      CREATE (c:Conversation {
        id: $id, title: null, type: 'direct', containsBot: true,
        createdAt: datetime($now), updatedAt: datetime($now), lastMessageAt: datetime($now)
      })
      CREATE (u)-[:PARTICIPATES_IN { joinedAt: datetime($now), role: 'owner' }]->(c)
      CREATE (bot)-[:PARTICIPATES_IN { joinedAt: datetime($now), role: 'member' }]->(c)
      WITH c
      MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
      WITH c, collect({ user: participant { .id, .name, .email, .isBot }, role: rel.role }) AS participants
      RETURN c { .*, containsBot: true, participants: participants } AS conversation
      `,
      { id: conversationId, userId, assistantId: ASSISTANT_USER_ID, now }
    );

    const conversation = toJS(result.records[0].get('conversation')) as Record<string, unknown>;
    const io = req.app.get('io') as IOServer | undefined;
    if (io) joinUserSocketsToConversation(io, userId, conversationId);

    res.status(201).json(conversation);
  } catch (error) {
    console.error('Error ensuring assistant conversation:', error);
    res.status(500).json({ error: 'Failed to ensure assistant conversation' });
  } finally {
    await session.close();
  }
});

export default router;
