import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ManagedTransaction, Session } from 'neo4j-driver';
import { acquireContextAclLocks, checkContextReadAccess } from './contextAccess.js';
import { ContextLaneError, projectContextPost } from './contextLane.js';

export type IntentionLifecycle = 'open'|'fulfilled'|'withdrawn';
const number=(value:any):number=>Number(value?.toNumber?.()??value??0);
const plain=(value:any):any=>{
  if(value==null)return value;
  if(typeof value.toNumber==='function')return value.toNumber();
  if(typeof value==='object'&&'year' in value)return value.toString();
  if(Array.isArray(value))return value.map(plain);
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,plain(v)]));
  return value;
};
const lifecycle=(i:any):IntentionLifecycle=>i.lifecycleState|| (i.status==='withdrawn'?'withdrawn':'open');
async function owned(tx:ManagedTransaction,userId:string,intentId:string){
  const result=await tx.run('MATCH (:User {id:$userId})-[:OWNS_INTENT]->(i:AgentIntent {id:$intentId}) SET i.lifecycleLock=coalesce(i.lifecycleLock,0)+1 RETURN i',{userId,intentId});
  if(!result.records.length)throw new ContextLaneError(404,'Intention not found');
  return result.records[0].get('i').properties;
}
async function project(tx:ManagedTransaction,userId:string,i:any){
  const contexts=await tx.run(`MATCH (t:Thought {lane:'context'})-[:REPRESENTS_INTENT]->(i:AgentIntent {id:$id})
    MATCH (owner:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation {id:t.conversationId})
    WHERE t.deletedAt IS NULL AND NOT EXISTS { MATCH (owner)-[:BLOCKED]-(:User {id:t.authorId}) }
    OPTIONAL MATCH (a:User {id:t.authorId})
    RETURN t,coalesce(c.name,c.title,head([(other:User)-[:PARTICIPATES_IN]->(c) WHERE other.id<>$userId | other.name]),'Conversation') AS title,a.name AS authorName ORDER BY t.createdAt DESC,t.id DESC`,{id:i.id,userId});
  const stories=await tx.run(`MATCH (:User {id:$userId})-[:OWNS_STORY]->(s:OpenChatStory)-[:ACTIVATES]->(:AgentIntent {id:$id})
    RETURN s ORDER BY s.createdAt DESC`,{userId,id:i.id});
  return {intentId:i.id,revision:number(i.lifecycleRevision),lifecycleState:lifecycle(i),searchStatus:i.status,
    contextOnly:i.contextOnly===true,kind:i.kind,expiresAt:plain(i.expiresAt)||null,goal:i.goal||i.terms||'',seeks:i.seeks||[],brings:i.brings||[],
    contextPosts:contexts.records.map(r=>({postId:r.get('t').properties.id,conversationId:r.get('t').properties.conversationId,
      conversationTitle:r.get('title')||'Conversation',sourceRevision:number(r.get('t').properties.intentionSourceRevision),
      sourceChanged:r.get('t').properties.intentionSourceChanged===true,post:projectContextPost(r.get('t'),r.get('authorName'))})),
    stories:stories.records.map(r=>{const s=plain(r.get('s').properties);return {...s,audience:{userIds:s.audienceUserIds||[],conversationIds:s.audienceConversationIds||[]}};})};
}
export async function listContextIntentions(session:Session,userId:string){
  return session.executeRead(async tx=>{
    const rows=await tx.run(`MATCH (:User {id:$userId})-[:OWNS_INTENT]->(i:AgentIntent)
      RETURN i ORDER BY coalesce(i.updatedAt,i.createdAt) DESC,i.id DESC LIMIT 200`,{userId});
    const intentions=[];for(const row of rows.records)intentions.push(await project(tx,userId,row.get('i').properties));
    return {intentions};
  });
}
export async function trackContextIntention(session:Session,userId:string,conversationId:string,postId:string,input:{sourceRevision:number;clientRequestId:string;intentId?:string}){
  if(!Number.isInteger(input.sourceRevision)||input.sourceRevision<1||typeof input.clientRequestId!=='string'||!input.clientRequestId.trim()||input.clientRequestId.length>200||
    (input.intentId!==undefined&&(typeof input.intentId!=='string'||!input.intentId.trim())))throw new ContextLaneError(400,'A source revision and clientRequestId are required');
  return session.executeWrite(async tx=>{
    await acquireContextAclLocks(tx,{userIds:[userId],conversationId});
    if(!await checkContextReadAccess(tx,userId,conversationId))throw new ContextLaneError(403,'Conversation is no longer available');
    const result=await tx.run(`MATCH (t:Thought {id:$postId,conversationId:$conversationId,lane:'context',authorId:$userId})
      WHERE t.deletedAt IS NULL AND t.kind IN ['ask','offer'] RETURN t`,{userId,postId,conversationId});
    if(!result.records.length)throw new ContextLaneError(404,'Your current Context ask or offer was not found');
    const t=result.records[0].get('t').properties;
    if(t.intentId){
      if(input.intentId&&input.intentId!==t.intentId)throw new ContextLaneError(409,'This post already represents another intention');
      if(t.intentionClientRequestId!==input.clientRequestId&&number(t.revision)!==input.sourceRevision)throw new ContextLaneError(409,'Context source changed; reload before linking');
      return {intention:await project(tx,userId,await owned(tx,userId,t.intentId))};
    }
    if(number(t.revision)!==input.sourceRevision)throw new ContextLaneError(409,'Context source changed; reload before linking');
    const reuse=await tx.run(`MATCH (t:Thought {authorId:$userId,lane:'context',intentionClientRequestId:$clientRequestId}) RETURN t.id AS id`,{userId,clientRequestId:input.clientRequestId});
    if(reuse.records.length)throw new ContextLaneError(409,'clientRequestId already tracked another post');
    const now=new Date().toISOString(),intentId=input.intentId||nanoid();
    if(input.intentId)await owned(tx,userId,intentId);
    else await tx.run(`MATCH (owner:User {id:$userId}) CREATE (i:AgentIntent {
      id:$intentId,ownerUserId:$userId,kind:$kind,terms:$terms,goal:$goal,seeks:$seeks,brings:$brings,
      matchingMode:'fulfillment',openToCollaborators:false,status:'paused',contextOnly:true,
      lifecycleState:'open',lifecycleRevision:0,audienceRestricted:true,audienceUserIds:[],audienceConversationIds:[$conversationId],
      createdAt:datetime($now),updatedAt:datetime($now)}) CREATE (owner)-[:OWNS_INTENT]->(i)`,
      {userId,intentId,kind:t.kind,terms:t.text.slice(0,2000),goal:t.text.slice(0,500),seeks:t.kind==='ask'?[t.text.slice(0,500)]:[],brings:t.kind==='offer'?[t.text.slice(0,500)]:[],conversationId,now});
    const i=await owned(tx,userId,intentId),state=lifecycle(i);
    // Linking never copies private goal/seeks/details into the shared projection or changes search consent.
    await tx.run(`MATCH (t:Thought {id:$postId}),(i:AgentIntent {id:$intentId})
      SET i.lifecycleState=$state,i.lifecycleRevision=coalesce(i.lifecycleRevision,0)+1,i.updatedAt=datetime($now)
      CREATE (t)-[:REPRESENTS_INTENT {sourceRevision:$sourceRevision,sourceDigest:$sourceDigest,createdAt:datetime($now),clientRequestId:$clientRequestId}]->(i)
      SET t.intentId=$intentId,t.intentionState=$state,t.intentionSourceRevision=$sourceRevision,t.intentionSourceChanged=false,
        t.intentionClientRequestId=$clientRequestId,t.status=CASE WHEN $state='open' THEN 'open' ELSE 'closed' END,
        t.revision=t.revision+1,t.updatedAt=datetime($now)
      WITH i MATCH (p:Thought)-[:REPRESENTS_INTENT]->(i) SET p.intentionRevision=i.lifecycleRevision`,
      {postId,intentId,sourceRevision:input.sourceRevision,sourceDigest:createHash('sha256').update(t.text).digest('hex'),clientRequestId:input.clientRequestId,state,now});
    return {intention:await project(tx,userId,await owned(tx,userId,intentId))};
  });
}
export async function updateContextIntention(session:Session,userId:string,intentId:string,input:{expectedRevision:number;lifecycleState:IntentionLifecycle}){
  if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<0||!['open','fulfilled','withdrawn'].includes(input.lifecycleState))throw new ContextLaneError(400,'Expected revision and valid lifecycle state are required');
  return session.executeWrite(async tx=>{
    await acquireContextAclLocks(tx,{userIds:[userId]});
    let i=await owned(tx,userId,intentId);
    if(number(i.lifecycleRevision)!==input.expectedRevision)throw new ContextLaneError(409,'Intention changed; reload before updating all linked projections');
    const contexts=await tx.run(`MATCH (t:Thought)-[:REPRESENTS_INTENT]->(:AgentIntent {id:$intentId}) WHERE t.deletedAt IS NULL RETURN DISTINCT t.conversationId AS id ORDER BY id`,{intentId});
    for(const row of contexts.records)await acquireContextAclLocks(tx,{conversationId:row.get('id')});
    // Reopening must not expose an old post to an audience the owner can no longer review.
    if(input.lifecycleState==='open')for(const row of contexts.records)if(!await checkContextReadAccess(tx,userId,row.get('id')))throw new ContextLaneError(409,'A linked conversation is no longer available; cannot reopen');
    if(input.lifecycleState==='open')for(const row of contexts.records){
      const quota=await tx.run(`MATCH (t:Thought {lane:'context',authorId:$userId,conversationId:$conversationId})
        WHERE t.deletedAt IS NULL AND t.kind IN ['ask','offer'] AND (coalesce(t.status,'open')='open' OR t.intentId=$intentId)
        RETURN count(t) AS count`,{userId,intentId,conversationId:row.get('id')});
      if(number(quota.records[0].get('count'))>50)throw new ContextLaneError(429,'Reopening would exceed 50 open asks/offers in this conversation');
    }
    if(lifecycle(i)===input.lifecycleState && input.lifecycleState==='open')return {intention:await project(tx,userId,i)};
    const now=new Date().toISOString();
    await reconcileIntentionLifecycle(tx,intentId,input.lifecycleState,now);
    i=await owned(tx,userId,intentId);return {intention:await project(tx,userId,i)};
  });
}

export async function reconcileIntentionLifecycle(tx:ManagedTransaction,intentId:string,state:IntentionLifecycle,now:string){
    const contexts=await tx.run(`MATCH (t:Thought)-[:REPRESENTS_INTENT]->(:AgentIntent {id:$intentId}) RETURN DISTINCT t.conversationId AS id ORDER BY id`,{intentId});
    for(const row of contexts.records)await acquireContextAclLocks(tx,{conversationId:row.get('id')});
    await tx.run(`MATCH (i:AgentIntent {id:$intentId}) SET i.lifecycleState=$state,i.lifecycleRevision=coalesce(i.lifecycleRevision,0)+1,
      i.status=CASE WHEN $state='open' THEN 'paused' WHEN i.status='connected' THEN 'connected' ELSE 'withdrawn' END,i.updatedAt=datetime($now)
      WITH i OPTIONAL MATCH (t:Thought)-[:REPRESENTS_INTENT]->(i)
      FOREACH (p IN CASE WHEN t IS NULL THEN [] ELSE [t] END | SET p.intentionState=$state,p.intentionRevision=i.lifecycleRevision,
        p.status=CASE WHEN $state='open' THEN 'open' ELSE 'closed' END,p.revision=p.revision+1,p.updatedAt=datetime($now))`,{intentId,state,now});
    if(state!=='open'){
      await tx.run(`MATCH (s:OpenChatStory)-[:ACTIVATES]->(:AgentIntent {id:$intentId}) SET s.status='withdrawn',s.updatedAt=datetime($now)`,{intentId,now});
      await tx.run(`MATCH (m:AgentMatch {status:'proposed'})-[:MATCHES]->(:AgentIntent {id:$intentId}) SET m.status='closed',m.updatedAt=datetime($now)`,{intentId,now});
    }
}
