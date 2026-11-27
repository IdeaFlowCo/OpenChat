import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { acquireContextAclLocks } from '../services/contextAccess.js';
import { publishConversationEvent } from '../services/conversationEvents.js';
import {assertAnnouncementThoughtMutation} from '../services/announcementThoughtAccess.js';
import {ContextLaneError} from '../services/contextLane.js';

const router = Router();
const statuses = new Set(['none', 'open', 'closed']);
const visibilities = new Set(['chat', 'private']);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const messageStatusThoughtId = (userId: string, messageId: string) => `message-status-${createHash('sha256').update(JSON.stringify([userId, messageId])).digest('hex')}`;
export type MessageStatusVisibility = 'chat' | 'private';

/**
 * One Stream capture per owner/message; no second status system.
 *
 * Visibility reuses the Stream's own sharing model: a status is visible to the
 * chat exactly when its Thought is PINNED_IN the source message's
 * conversation, the same edge a shared Stream item uses. "private" means no
 * such pin. A request that omits visibility keeps the current state, and a new
 * capture without one stays private, so older clients keep their promise.
 */
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
      RETURN t.id AS thoughtId, coalesce(t.status,'none') AS status,
        CASE WHEN t IS NOT NULL AND EXISTS { MATCH (t)-[:PINNED_IN]->(c) } THEN 'chat' ELSE 'private' END AS visibility
    `, { userId, id, thoughtId: messageStatusThoughtId(userId, id) });
    if (!result.records.length) { res.status(404).json({ error: 'Message unavailable' }); return; }
    const row = result.records[0]!;
    res.json({ messageId: id, thoughtId: row.get('thoughtId'), status: row.get('status'), visibility: row.get('visibility') ?? 'private' });
  } catch { res.status(500).json({ error: 'Could not load message status' }); }
  finally { await session.close(); }
});

/**
 * Statuses a participant may see on this conversation's messages: everyone's
 * statuses shared with this chat, plus the caller's own private ones. Another
 * participant's private status is never returned.
 */
router.get('/conversation', requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!validId(req.query.conversationId)) { res.status(404).json({ error: 'Conversation unavailable' }); return; }
  const userId = req.user!.userId, conversationId = req.query.conversationId;
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
      OPTIONAL MATCH (m:Message {conversationId:c.id})<-[:FROM_MESSAGE]-(t:Thought)
      WHERE m.deletedAt IS NULL AND t.deletedAt IS NULL AND (t.lane IS NULL OR t.lane <> 'context')
        AND t.status IN ['open','closed'] AND t.captureMethod = 'message-status'
        AND (t.userId = $userId OR (EXISTS { MATCH (t)-[:PINNED_IN]->(c) } AND EXISTS { MATCH (:User {id:t.userId})-[:PARTICIPATES_IN]->(c) }))
      OPTIONAL MATCH (author:User {id:t.userId})
      WITH c, m, t, author ORDER BY t.updatedAt DESC
      WITH c, collect(CASE WHEN t IS NULL THEN null ELSE {
        messageId: m.id, status: t.status, userId: t.userId, userName: coalesce(author.name, 'Member'),
        visibility: CASE WHEN EXISTS { MATCH (t)-[:PINNED_IN]->(c) } THEN 'chat' ELSE 'private' END,
        own: t.userId = $userId, updatedAt: toString(t.updatedAt)
      } END)[0..500] AS statuses
      RETURN c.id AS conversationId, statuses
    `, { userId, conversationId });
    if (!result.records.length) { res.status(404).json({ error: 'Conversation unavailable' }); return; }
    res.json({ conversationId, statuses: (result.records[0]!.get('statuses') as unknown[]).filter(Boolean) });
  } catch { res.status(500).json({ error: 'Could not load message statuses' }); }
  finally { await session.close(); }
});

router.put('/', requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  if (!validId(req.query.messageId)) { res.status(404).json({ error: 'Message unavailable' }); return; }
  const status = req.body?.status;
  if (typeof status !== 'string' || !statuses.has(status)) { res.status(400).json({ error: 'Choose no status, open or closed' }); return; }
  const requestedVisibility = req.body?.visibility;
  if (requestedVisibility !== undefined && (typeof requestedVisibility !== 'string' || !visibilities.has(requestedVisibility))) {
    res.status(400).json({ error: 'Choose this chat or only me' }); return;
  }
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
        RETURN c.id AS conversationId, t.id AS thoughtId,
          t IS NOT NULL AND EXISTS { MATCH (t)-[:PINNED_IN]->(c) } AS shared
      `, { userId, id, thoughtId });
      if (!source.records.length) return null;
      const existing = source.records[0]!.get('thoughtId');
      const wasShared = source.records[0]!.get('shared') === true;
      const conversationId = source.records[0]!.get('conversationId') as string;
      if (status === 'none' && !existing) return { thoughtId: null, status: 'none', visibility: 'private' as const, thought: null, created: false, conversationId, wasShared: false };
      // Clearing a status also withdraws the pin this action created.
      const visibility: MessageStatusVisibility = status === 'none' ? 'private'
        : (requestedVisibility as MessageStatusVisibility | undefined) ?? (wasShared ? 'chat' : 'private');
      if (existing || visibility==='chat' || wasShared) {
        await assertAnnouncementThoughtMutation(tx,userId,thoughtId,[{conversationId,requireWrite:visibility==='chat'||wasShared}]);
      } else await acquireContextAclLocks(tx, { conversationId });
      // Recheck access after the ACL lock.
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
        // Read the pin state again inside the locked write, so events reflect what this write changed.
        WITH u,c,m,t, EXISTS { MATCH (t)-[:PINNED_IN]->(c) } AS sharedBefore
        CALL {
          WITH c,t
          WITH c,t WHERE $visibility = 'chat'
          MERGE (t)-[p:PINNED_IN]->(c) ON CREATE SET p.pinnedBy=$userId, p.pinnedAt=datetime($now), p.via='message-status'
          RETURN count(p) AS pinned
        }
        CALL {
          WITH c,t
          WITH c,t WHERE $visibility = 'private'
          OPTIONAL MATCH (t)-[p:PINNED_IN]->(c)
          DELETE p
          RETURN count(p) AS unpinned
        }
        RETURN t { .id,.text,.kind,.status,.createdAt,.updatedAt,.scopeConversationId,.captureMethod,
          tags:coalesce(t.tags,[]),hasSourceMessage:true,sourceMessageId:m.id,sourceConversationId:c.id,pinned:$visibility='chat' } AS thought,
          coalesce(u.name,'Member') AS userName, sharedBefore
      `, { userId, id, thoughtId, conversationId, status, visibility, now: new Date().toISOString() });
      if (!result.records.length) return null;
      const raw = result.records[0]!.get('thought') as Record<string, unknown>;
      const thought = { ...raw, createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt) };
      return { thoughtId, status, visibility, thought, created: !existing, conversationId, wasShared: result.records[0]!.get('sharedBefore') === true, userName: String(result.records[0]!.get('userName')) };
    });
    if (!saved) { res.status(404).json({ error: 'Message unavailable' }); return; }
    const io = req.app.get('io');
    if (saved.thought) io?.to(`user:${userId}`).emit(saved.created ? 'thought:created' : 'thought:updated', { thought: saved.thought });
    const shared = saved.visibility === 'chat';
    if (io && (shared || saved.wasShared)) {
      // Participants learn only what this chat can see: the shared status, or
      // that a previously shared status was withdrawn (never the private value).
      const now = new Date().toISOString();
      await publishConversationEvent(io, saved.conversationId, 'message-status:changed', {
        conversationId: saved.conversationId, messageId: id, userId, userName: saved.userName,
        status: shared ? saved.status : 'none', visibility: shared ? 'chat' : 'private',
      }).catch(() => undefined);
      if (shared && !saved.wasShared && saved.thought) {
        await publishConversationEvent(io, saved.conversationId, 'thought:pinned', {
          conversationId: saved.conversationId,
          thought: { ...saved.thought, pinned: true, pinnedBy: userId, pinnedAt: now, authorId: userId },
        }).catch(() => undefined);
      } else if (!shared && saved.wasShared) {
        await publishConversationEvent(io, saved.conversationId, 'thought:unpinned', { conversationId: saved.conversationId, thoughtId: saved.thoughtId }).catch(() => undefined);
      }
    }
    res.json({ messageId: id, thoughtId: saved.thoughtId, status: saved.status, visibility: saved.visibility });
  } catch(error) {
    if(error instanceof ContextLaneError){res.status(error.statusCode).json({error:error.message});return;}
    res.status(500).json({ error: 'Could not save message status' });
  }
  finally { await session.close(); }
});
export default router;
