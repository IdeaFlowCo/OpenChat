import type { Session } from 'neo4j-driver';
import { acquireContextAclLocks, checkContextReadAccess } from './contextAccess.js';
import { ContextLaneError } from './contextLane.js';
export async function pinThoughtWithReview(session: Session, userId: string, id: string, conversationId: string, now: string, expectedText?: string) {
  if (typeof expectedText !== 'string' || expectedText.length > 20000) throw new ContextLaneError(400, 'Reviewed expectedText is required and must be at most 20000 characters');
  return session.executeWrite(async tx => {
    await acquireContextAclLocks(tx, { userIds: [userId], conversationId });
    if (!await checkContextReadAccess(tx, userId, conversationId)) throw new ContextLaneError(404, 'Thought or conversation not found (or not yours)');
    const locked = await tx.run(`MATCH (:User {id:$userId})-[:HAS_THOUGHT]->(t:Thought {id:$id})
      WHERE (t.lane IS NULL OR t.lane<>'context') AND t.deletedAt IS NULL
      SET t.pinApprovalRevision=coalesce(t.pinApprovalRevision,0)+1 RETURN t.text AS text`, { userId, id });
    if (!locked.records.length) throw new ContextLaneError(404, 'Thought or conversation not found (or not yours)');
    if (locked.records[0].get('text') !== expectedText) throw new ContextLaneError(409, 'Entry changed. Reload and review its current text before sharing.');
    return tx.run(`MATCH (u:User {id:$userId})-[:HAS_THOUGHT]->(t:Thought {id:$id})
      MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
      MERGE (t)-[p:PINNED_IN]->(c) ON CREATE SET p.pinnedBy=$userId,p.pinnedAt=datetime($now)
      WITH u,t OPTIONAL MATCH (t)-[:FROM_MESSAGE]->(m:Message)
      RETURN t { .id,.text,.kind,.status,.createdAt,.updatedAt,tags:coalesce(t.tags,[]),hasSourceMessage:m IS NOT NULL,
        sourceMessageId:CASE WHEN m.deletedAt IS NULL AND EXISTS { MATCH (u)-[:PARTICIPATES_IN]->(:Conversation {id:m.conversationId}) } THEN m.id ELSE null END,
        sourceConversationId:CASE WHEN m.deletedAt IS NULL AND EXISTS { MATCH (u)-[:PARTICIPATES_IN]->(:Conversation {id:m.conversationId}) } THEN m.conversationId ELSE null END } AS thought`, { userId, id, conversationId, now });
  });
}
