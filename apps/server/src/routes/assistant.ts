/**
 * Assistant routes (openchat-bfn.3).
 *
 * POST /api/assistant/ensure — idempotently MERGE a direct conversation
 * between the caller and the singleton Assistant bot (containsBot=true), so
 * clients can open/pin an "Assistant" chat. Returns the conversation.
 */

import { Router, Request, Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { maybeTriggerAssistant } from '../services/assistantTrigger.js';
import { ensureDirectConversation } from '../services/directConversation.js';
import {
  ensureAssistantUser,
  ensureAssistantConversation,
  postMessageAs,
  ASSISTANT_USER_ID,
} from '../services/assistant.js';

const router = Router();

// POST /api/assistant/ensure
router.post('/ensure', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // The assistant bot must exist (boot does this, but be defensive).
  await ensureAssistantUser();

  try {
    const io = req.app.get('io') as IOServer | undefined;
    const result = await ensureDirectConversation(userId, ASSISTANT_USER_ID, io);
    res.status(result.created ? 201 : 200).json(result.conversation);
  } catch (error) {
    console.error('Error ensuring assistant conversation:', error);
    res.status(500).json({ error: 'Failed to ensure assistant conversation' });
  }
});

// POST /api/assistant/forward (openchat-ug6)
// Body: { sourceConversationId, sourceMessageId, question? }
// Forwards a message from a source conversation INTO the caller's private
// Assistant DM (authored by the caller), then lets the normal trigger run the
// assistant turn. Never writes back into the source conversation.
router.post('/forward', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { sourceConversationId, sourceMessageId, question } = (req.body ?? {}) as {
    sourceConversationId?: unknown;
    sourceMessageId?: unknown;
    question?: unknown;
  };

  if (typeof sourceConversationId !== 'string' || !sourceConversationId.trim()) {
    res.status(400).json({ error: 'sourceConversationId is required' });
    return;
  }
  if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim()) {
    res.status(400).json({ error: 'sourceMessageId is required' });
    return;
  }
  const questionText =
    typeof question === 'string' && question.trim() ? question.trim().slice(0, 2000) : '';

  const session = getDriver().session();
  let sourceContent: string;
  let senderName: string;
  let sourceConvName: string;
  try {
    // Verify the caller participates in the source conversation AND load the
    // source message (content + sender name) + a display name in one query.
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $sourceConversationId})
      MATCH (m:Message {id: $sourceMessageId, conversationId: $sourceConversationId})
      WHERE m.deletedAt IS NULL
      OPTIONAL MATCH (sender:User {id: m.senderId})
      OPTIONAL MATCH (other:User)-[:PARTICIPATES_IN]->(c)
      WHERE other.id <> $userId AND coalesce(other.isBot, false) = false
      WITH c, m, sender, collect(DISTINCT other.name) AS otherNames
      RETURN m.content AS content,
             coalesce(sender.name, 'Unknown') AS senderName,
             c.title AS title,
             otherNames AS otherNames
      LIMIT 1
      `,
      { userId, sourceConversationId, sourceMessageId }
    );
    if (result.records.length === 0) {
      // Either the caller doesn't participate or the message doesn't exist.
      res.status(404).json({ error: 'Source message not found or access denied' });
      return;
    }
    const rec = result.records[0];
    sourceContent = (rec.get('content') as string) ?? '';
    senderName = (rec.get('senderName') as string) ?? 'Unknown';
    const title = rec.get('title') as string | null;
    const otherNames = ((rec.get('otherNames') as (string | null)[]) || []).filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0
    );
    sourceConvName = (title && title.trim()) || otherNames.join(', ') || 'a conversation';
  } catch (error) {
    console.error('Error loading source message for forward:', error);
    res.status(500).json({ error: 'Failed to forward message' });
    return;
    // session closed in finally
  } finally {
    await session.close();
  }

  try {
    const io = req.app.get('io') as IOServer | undefined;

    // Ensure the caller's private Assistant DM exists (shared helper).
    const assistantDmId = await ensureAssistantConversation(userId, io);

    // Compose the forwarded message, authored by the USER, into the DM only.
    const forwardBody =
      `Forwarded from ${sourceConvName}/${senderName}:\n` +
      `“${sourceContent}”` +
      (questionText ? `\n\n${questionText}` : '');

    const posted = await postMessageAs(io, userId, assistantDmId, forwardBody);
    if (!posted) {
      res.status(500).json({ error: 'Failed to post forwarded message' });
      return;
    }

    // Fire the normal assistant turn (same loop guard as chat.ts). The user is
    // the sender, so this is safe and not a bot self-trigger.
    maybeTriggerAssistant({ senderId: userId, conversationId: assistantDmId, io });

    res.status(201).json({ conversationId: assistantDmId });
  } catch (error) {
    console.error('Error forwarding message to assistant:', error);
    res.status(500).json({ error: 'Failed to forward message' });
  }
});

export default router;
