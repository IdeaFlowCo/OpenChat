import type {ManagedTransaction} from 'neo4j-driver';
import {acquireContextAclLocks,checkContextWriteAccess} from './contextAccess.js';
import {ContextLaneError} from './contextLane.js';

/** Call while holding the thought owner's User ACL lock. Sharing paths take
 * that same lock, so an entry cannot become shared between this scan and edit.
 * Private unshared captures remain writable; shared announcement content must
 * satisfy every current announcement audience before it can change. */
export async function assertAnnouncementThoughtMutation(tx:ManagedTransaction,userId:string,thoughtId:string,extraTargets:Array<{conversationId:string;requireWrite:boolean}>=[]){
  const r=await tx.run(`MATCH(t:Thought {id:$thoughtId})
    WHERE t.userId=$userId OR EXISTS { MATCH(:User {id:$userId})-[:HAS_THOUGHT]->(t) }
    CALL {
      WITH t MATCH(t)-[:PINNED_IN|PINNED_TO|SHARED_IN]->(c:Conversation) WHERE c.communityKind='announcements' RETURN c
      UNION
      WITH t MATCH(t)-[:FROM_MESSAGE]->(m:Message),(c:Conversation {id:m.conversationId})
      WHERE c.communityKind='announcements' AND t.captureMethod IN ['inline-tag','reply-tag'] RETURN c
    }
    RETURN DISTINCT c.id AS id ORDER BY id`,{userId,thoughtId});
  const required=new Set(r.records.map(row=>row.get('id') as string));
  const targets=[...new Set([...required,...extraTargets.map(t=>t.conversationId)])].sort();
  for(const conversationId of targets){
    await acquireContextAclLocks(tx,{conversationId});
    if(required.has(conversationId)||extraTargets.some(t=>t.conversationId===conversationId&&t.requireWrite)){
      await assertAnnouncementTargetWrite(tx,userId,conversationId);
    }
  }
}

/** A legacy unpin keeps its existing normal-chat policy, while announcements
 * require current admin authority. The caller holds owner User then chat locks. */
export async function assertAnnouncementTargetWrite(tx:ManagedTransaction,userId:string,conversationId:string){
  const r=await tx.run(`MATCH(c:Conversation {id:$conversationId}) RETURN c.communityKind AS kind`,{conversationId});
  if(r.records[0]?.get('kind')==='announcements'&&!await checkContextWriteAccess(tx,userId,conversationId))throw new ContextLaneError(403,'Only current community admins can share or change announcements.');
}
