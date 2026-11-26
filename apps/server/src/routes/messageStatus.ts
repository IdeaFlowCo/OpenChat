import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { acquireContextAclLocks } from '../services/contextAccess.js';

const router = Router();
const statuses = new Set(['none', 'open', 'closed']);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const messageStatusThoughtId = (userId: string, messageId: string) => `message-status-${createHash('sha256').update(JSON.stringify([userId, messageId])).digest('hex')}`;

/** One owner-private Stream capture per message; no second status system. */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!validId(req.query.messageId)) { res.status(404).json({ error: 'Message unavailable' }); return; }
  const userId = req.user!.userId, id = req.query.messageId;
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation)
      MATCH (m:Message {id:$id, conversationId:c.id}) WHERE m.deletedAt IS NULL
      OPTIONAL MATCH (t:Thought {id:$thoughtId, userId:$userId})-[:FROM_MESSAGE]->(m)
      RETURN t.id AS thoughtId, coalesce(t.status,'none') AS status
    `, { userId, id, thoughtId: messageStatusThoughtId(userId, id) });
    if (!result.records.length) { res.status(404).json({ error: 'Message unavailable' }); return; }
    res.json({ messageId: id, thoughtId: result.records[0]!.get('thoughtId'), status: result.records[0]!.get('status') });
  } catch { res.status(500).json({ error: 'Could not load message status' }); }
  finally { await session.close(); }
});

router.put('/', requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!validId(req.query.messageId)) { res.status(404).json({ error: 'Message unavailable' }); return; }
  const status = req.body?.status;
  if (typeof status !== 'string' || !statuses.has(status)) { res.status(400).json({ error: 'Choose no status, open or closed' }); return; }
  const userId = req.user!.userId, id = req.query.messageId, thoughtId = messageStatusThoughtId(userId, id);
  const session = getDriver().session();
  try {
    const saved = await session.executeWrite(async tx => {
      // The owner lock serializes status writes, including the first capture.
      await acquireContextAclLocks(tx, { userIds: [userId] });
      const source = await tx.run(`
        MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation)
        MATCH (m:Message {id:$id, conversationId:c.id}) WHERE m.deletedAt IS NULL
        OPTIONAL MATCH (t:Thought {id:$thoughtId, userId:$userId})-[:FROM_MESSAGE]->(m)
        RETURN c.id AS conversationId, t.id AS thoughtId
      `, { userId, id, thoughtId });
      if (!source.records.length) return null;
      const existing = source.records[0]!.get('thoughtId');
      if (status === 'none' && !existing) return { thoughtId: null, status: 'none', thought: null, created: false };
      const conversationId = source.records[0]!.get('conversationId') as string;
      await acquireContextAclLocks(tx, { conversationId });
      // Recheck access after the ACL lock. No PINNED_IN or shared capture method.
      const result = await tx.run(`
        MATCH (u:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
        MATCH (m:Message {id:$id, conversationId:c.id}) WHERE m.deletedAt IS NULL
        MERGE (t:Thought {id:$thoughtId})
        ON CREATE SET t.userId=$userId, t.text=CASE WHEN trim(coalesce(m.content,''))='' THEN 'Message' ELSE left(m.content,4000) END,
          t.kind='observation', t.captureMethod='message-status', t.createdAt=datetime($now), t.tags=[], t.scopeConversationId=c.id
        WITH u,c,m,t WHERE t.userId=$userId
        SET t.status=$status, t.updatedAt=datetime($now)
        MERGE (u)-[:HAS_THOUGHT]->(t)
        MERGE (t)-[:FROM_MESSAGE]->(m)
        RETURN t { .id,.text,.kind,.status,.createdAt,.updatedAt,.scopeConversationId,.captureMethod,
          tags:coalesce(t.tags,[]),hasSourceMessage:true,sourceMessageId:m.id,sourceConversationId:c.id,pinned:false } AS thought
      `, { userId, id, thoughtId, conversationId, status, now: new Date().toISOString() });
      if (!result.records.length) return null;
      const raw = result.records[0]!.get('thought') as Record<string, unknown>;
      const thought = { ...raw, createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt) };
      return { thoughtId, status, thought, created: !existing };
    });
    if (!saved) { res.status(404).json({ error: 'Message unavailable' }); return; }
    if (saved.thought) req.app.get('io')?.to(`user:${userId}`).emit(saved.created ? 'thought:created' : 'thought:updated', { thought: saved.thought });
    res.json({ messageId: id, thoughtId: saved.thoughtId, status: saved.status });
  } catch { res.status(500).json({ error: 'Could not save message status' }); }
  finally { await session.close(); }
});
export default router;
