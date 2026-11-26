import { Router, type Request, type Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const messageId = /^[A-Za-z0-9_-]{1,200}$/;
const unavailable = { error: 'Message unavailable' };
const plain = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object' && 'year' in value) return String(value);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
};

/** A message URL grants no access: membership is checked on both reads. */
router.get('/:id/context', requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (typeof req.params.id !== 'string' || !messageId.test(req.params.id)) { res.status(404).json(unavailable); return; }
  const session = getDriver().session();
  try {
    const parameters = { userId: req.user!.userId, messageId: req.params.id };
    const result = await session.run(`
      MATCH (viewer:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
      MATCH (m:Message {id: $messageId, conversationId: c.id})
      WHERE m.deletedAt IS NULL
      RETURN c { .id, .name, .type } AS conversation
    `, parameters);
    if (!result.records.length) { res.status(404).json(unavailable); return; }
    const conversation = plain(result.records[0]!.get('conversation')) as { id: string };
    const neighbors = await session.run(`
      MATCH (viewer:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      MATCH (source:Message {id: $messageId, conversationId: c.id})
      WHERE source.deletedAt IS NULL
      CALL {
        WITH c, source
        MATCH (m:Message {conversationId: c.id})
        WHERE m.deletedAt IS NULL AND (m.createdAt < source.createdAt OR (m.createdAt = source.createdAt AND m.id < source.id))
        WITH m ORDER BY m.createdAt DESC, m.id DESC LIMIT 5 RETURN collect(m) AS before
      }
      CALL {
        WITH c, source
        MATCH (m:Message {conversationId: c.id})
        WHERE m.deletedAt IS NULL AND (m.createdAt > source.createdAt OR (m.createdAt = source.createdAt AND m.id > source.id))
        WITH m ORDER BY m.createdAt ASC, m.id ASC LIMIT 5 RETURN collect(m) AS after
      }
      UNWIND reverse(before) + [source] + after AS m
      OPTIONAL MATCH (sender:User {id: m.senderId})
      RETURN m { .id, .content, .createdAt, .messageType, senderName: sender.name } AS message
      ORDER BY m.createdAt ASC, m.id ASC
    `, { ...parameters, conversationId: conversation.id });
    if (!neighbors.records.length) { res.status(404).json(unavailable); return; }
    res.json({ conversation, messageId: parameters.messageId, messages: neighbors.records.map(record => plain(record.get('message'))) });
  } catch {
    res.status(500).json({ error: 'Could not load message' });
  } finally { await session.close(); }
});

export default router;
