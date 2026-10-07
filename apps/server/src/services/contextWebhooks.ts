import { createHash, createHmac, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Driver, Session, ManagedTransaction } from 'neo4j-driver';
import { isContextLaneEnabled } from '../config/features.js';
import { acquireContextAclLocks } from './contextAccess.js';
import { ContextLaneError } from './contextLane.js';
import { deliverContextWebhookOnce } from './webhookDispatch.js';

// Separate consent from message webhooks: only a request-ID wake, never shared/private text.
export const contextWebhooksAvailable = () => isContextLaneEnabled() && process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED === 'true';
const activeKey = `k.revokedAt IS NULL AND (k.expiresAt IS NULL OR k.expiresAt>$now)
 AND 'read' IN coalesce(k.scopes,[]) AND 'write' IN coalesce(k.scopes,[]) AND k.contextRequestsEnabled=true`;
const liveDelivery = `MATCH (w:ContextWebhook {id:d.subscriptionId,enabled:true})
 MATCH (r:ContextAgentRequest {id:d.requestId,status:'pending'})
 MATCH (k:AgentKey {id:w.agentKeyId,ownerUserId:w.ownerUserId})
 MATCH (owner:User {id:w.ownerUserId})-[:PARTICIPATES_IN]->(c:Conversation {id:w.conversationId})
 MATCH (requester:User {id:r.requesterId})-[:PARTICIPATES_IN]->(c)
 MATCH (t:Thought {id:r.postId,conversationId:w.conversationId,lane:'context'})
 WHERE ${activeKey} AND r.agentKeyId=k.id AND r.ownerUserId=owner.id
 AND r.conversationId=c.id AND r.expiresAt>$now AND w.generation=d.generation AND d.leaseUntil>$now
 AND t.deletedAt IS NULL AND t.revision=r.sourceRevision AND coalesce(t.status,'open')<>'closed'
 AND NOT coalesce(t.intentionState,'open') IN ['fulfilled','withdrawn']
 AND NOT (owner)-[:BLOCKED]-(requester)`;

export function validateContextWebhookUrl(value: unknown): string {
 if(typeof value!=='string'||value.length>2048)throw new ContextLaneError(400,'A public HTTPS endpoint is required');
 try { const url=new URL(value); if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error(); return url.toString(); }
 catch {throw new ContextLaneError(400,'Use an HTTPS endpoint without credentials or a fragment');}
}
const projection=`w {.id,.conversationId,.agentKeyId,.url,.enabled,.createdAt,.generation}`;
export async function listContextWebhooks(session:Session,userId:string) {
 const rows=await session.run(`MATCH (w:ContextWebhook {ownerUserId:$userId}) RETURN ${projection} AS subscription ORDER BY w.createdAt`,{userId});
 return {available:contextWebhooksAvailable(),subscriptions:rows.records.map(r=>r.get('subscription'))};
}
export async function createContextWebhook(session:Session,userId:string,input:any) {
 if(!contextWebhooksAvailable())throw new ContextLaneError(503,'Context webhooks are not enabled on this server');
 const url=validateContextWebhookUrl(input?.url);
 if(input?.consent!==true||typeof input?.conversationId!=='string'||!input.conversationId||typeof input?.agentKeyId!=='string'||!input.agentKeyId)
  throw new ContextLaneError(400,'Choose a conversation and receiving key, and approve sending request IDs to this endpoint');
 if(typeof input.clientRequestId!=='string'||!input.clientRequestId||input.clientRequestId.length>120)throw new ContextLaneError(400,'clientRequestId is required');
 return session.executeWrite(async tx=>{
  await acquireContextAclLocks(tx,{userIds:[userId],conversationId:input.conversationId,agentKeyId:input.agentKeyId});
  const args={userId,conversationId:input.conversationId,agentKeyId:input.agentKeyId,url,now:new Date().toISOString(),requestId:input.clientRequestId};
  const allowed=await tx.run(`MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(:Conversation {id:$conversationId})
   MATCH (k:AgentKey {id:$agentKeyId,ownerUserId:$userId}) WHERE ${activeKey} RETURN k.id`,args);
  if(!allowed.records.length)throw new ContextLaneError(403,'Choose your active read/write key with Context requests enabled in a conversation you belong to');
  const existing=await tx.run(`MATCH (w:ContextWebhook {ownerUserId:$userId})
   WHERE w.clientRequestId=$requestId OR (w.conversationId=$conversationId AND w.agentKeyId=$agentKeyId AND w.enabled=true)
   RETURN w ORDER BY CASE WHEN w.clientRequestId=$requestId THEN 0 ELSE 1 END LIMIT 1`,args);
  if(existing.records.length){const w=existing.records[0].get('w').properties;
   if(w.url!==url||w.conversationId!==input.conversationId||w.agentKeyId!==input.agentKeyId||!w.enabled)throw new ContextLaneError(409,'A different or disabled subscription already exists; remove it before creating another');
   return {subscription:{id:w.id,conversationId:w.conversationId,agentKeyId:w.agentKeyId,url:w.url,enabled:w.enabled,createdAt:w.createdAt,generation:Number(w.generation)},secret:w.secret};
  }
  const count=await tx.run(`MATCH (w:ContextWebhook {ownerUserId:$userId,enabled:true}) RETURN count(w) AS count`,{userId});
  if(Number(count.records[0].get('count'))>=10)throw new ContextLaneError(429,'Limit of 10 Context webhook subscriptions reached');
  const secret='cwh_'+randomBytes(32).toString('base64url');
  const row=await tx.run(`CREATE (w:ContextWebhook {id:$id,ownerUserId:$userId,conversationId:$conversationId,agentKeyId:$agentKeyId,
   url:$url,secret:$secret,enabled:true,generation:1,createdAt:$now,clientRequestId:$requestId}) RETURN ${projection} AS subscription`,{...args,id:nanoid(),secret});
  return {subscription:row.records[0].get('subscription'),secret};
 });
}
export async function deleteContextWebhook(session:Session,userId:string,id:string) {
 return session.executeWrite(async tx=>{
  await acquireContextAclLocks(tx,{userIds:[userId]});
  const r=await tx.run(`MATCH (w:ContextWebhook {id:$id,ownerUserId:$userId}) SET w.enabled=false,w.generation=coalesce(w.generation,1)+1
   REMOVE w.secret RETURN w.id`,{id,userId});
  if(!r.records.length)throw new ContextLaneError(404,'Subscription not found');
  await tx.run(`MATCH (d:ContextWebhookDelivery {subscriptionId:$id}) WHERE d.status IN ['pending','delivering'] SET d.status='cancelled',d.finishedAt=$now REMOVE d.leaseToken`,{id,now:new Date().toISOString()});
  return {deleted:true};
 });
}
export async function enqueueContextWebhook(tx:ManagedTransaction,requestId:string) {
 // Only subscriptions present at request creation are eligible. No historical replay on opt-in.
 if(!contextWebhooksAvailable())return;
 await tx.run(`MATCH (r:ContextAgentRequest {id:$requestId})
  MATCH (w:ContextWebhook {agentKeyId:r.agentKeyId,ownerUserId:r.ownerUserId,conversationId:r.conversationId,enabled:true})
  MERGE (d:ContextWebhookDelivery {id:w.id+':'+r.id})
  ON CREATE SET d.subscriptionId=w.id,d.requestId=r.id,d.ownerUserId=r.ownerUserId,d.conversationId=r.conversationId,
   d.agentKeyId=r.agentKeyId,d.generation=w.generation,d.status='pending',d.attempts=0,d.createdAt=r.createdAt,
   d.nextAttemptAt=$now,d.expiresAt=r.expiresAt`,{requestId,now:new Date().toISOString()});
}
export function contextWakeEnvelope(eventId:string,requestId:string,secret:string,now=Date.now()) {
 const body=JSON.stringify({id:eventId,event:'context.requested',requestId});
 const timestamp=String(Math.floor(now/1000));
 return {body,headers:{'Content-Type':'application/json','X-OpenChat-Event-Id':eventId,'X-OpenChat-Timestamp':timestamp,
  'X-OpenChat-Signature':'sha256='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex')}};
}
export async function ensureContextWebhookIndexes(driver:Driver) {
 const s=driver.session();try{for(const label of ['ContextWebhook','ContextWebhookDelivery','ContextWebhookWorker'])await s.run(`CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);}finally{await s.close();}
}
export type ContextWebhookTransport=(url:string,headers:Record<string,string>,body:string)=>Promise<boolean|'blocked'>;
export async function runContextWebhookOnce(driver:Driver,transport:ContextWebhookTransport=deliverContextWebhookOnce):Promise<boolean> {
 if(!contextWebhooksAvailable())return false;
 const s=driver.session(); const now=new Date().toISOString(),token=nanoid();
 try {
  const claim=await s.executeWrite(async tx=>{
   // Serializes claims across processes; outbound I/O happens after this short transaction.
   await tx.run(`MERGE (w:ContextWebhookWorker {id:'dispatcher'}) SET w.revision=coalesce(w.revision,0)+1`);
   await tx.run(`MATCH (d:ContextWebhookDelivery) WHERE d.status IN ['pending','delivering'] AND (d.expiresAt<=$now OR d.attempts>=4 AND d.leaseUntil<=$now)
    SET d.status='expired',d.finishedAt=$now REMOVE d.leaseToken`,{now});
   const slots=await tx.run(`MATCH (d:ContextWebhookDelivery {status:'delivering'}) WHERE d.leaseUntil>$now RETURN count(d) AS count`,{now});
   if(Number(slots.records[0].get('count'))>=2)return null;
   const rows=await tx.run(`MATCH (d:ContextWebhookDelivery) WHERE d.expiresAt>$now AND d.attempts<4
    AND ((d.status='pending' AND d.nextAttemptAt<=$now) OR (d.status='delivering' AND d.leaseUntil<=$now))
    RETURN d ORDER BY d.createdAt,d.id LIMIT 1`,{now});
   if(!rows.records.length)return null;
   const d=rows.records[0].get('d').properties;
   await tx.run(`MATCH (d:ContextWebhookDelivery {id:$id}) SET d.status='delivering',d.leaseToken=$token,d.leaseUntil=$until,d.attempts=d.attempts+1`,{id:d.id,token,until:new Date(Date.now()+30_000).toISOString()});
   return d;
  });
  if(!claim)return false;
  // Manual transaction: never automatically replay external I/O on a transaction retry.
  // Hold the same ACL locks as revocation/membership changes until the bounded send finishes.
  const tx=s.beginTransaction();
  try {
   await acquireContextAclLocks(tx as unknown as ManagedTransaction,{userIds:[claim.ownerUserId],conversationId:claim.conversationId,agentKeyId:claim.agentKeyId});
   const checked=await tx.run(`MATCH (d:ContextWebhookDelivery {id:$id,leaseToken:$token,status:'delivering'}) ${liveDelivery}
    RETURN w.url AS url,w.secret AS secret,r.id AS requestId`,{id:claim.id,token,now:new Date().toISOString()});
   if(!checked.records.length||!contextWebhooksAvailable()) {
    await tx.run(`MATCH (d:ContextWebhookDelivery {id:$id,leaseToken:$token}) SET d.status='cancelled',d.finishedAt=$now REMOVE d.leaseToken`,{id:claim.id,token,now});
   } else {
    const row=checked.records[0],eventId=createHash('sha256').update(claim.id).digest('hex');
    const envelope=contextWakeEnvelope(eventId,row.get('requestId'),row.get('secret'));
    let result:boolean|'blocked'=false;
    try{result=await transport(row.get('url'),envelope.headers,envelope.body);}catch{/* Fixed failure category; no endpoint or credentials logged. */}
    const exhausted=Number(claim.attempts)+1>=4;
    const status=result===true?'delivered':result==='blocked'?'blocked':exhausted?'failed':'pending';
    await tx.run(`MATCH (d:ContextWebhookDelivery {id:$id,leaseToken:$token}) SET d.status=$status,d.lastAttemptAt=$now,d.nextAttemptAt=$next,
     d.finishedAt=CASE WHEN $status='pending' THEN null ELSE $now END REMOVE d.leaseToken`,
     {id:claim.id,token,status,now:new Date().toISOString(),next:new Date(Date.now()+[30_000,120_000,600_000,600_000][Number(claim.attempts)]).toISOString()});
   }
   await tx.commit();
  }catch(error){await tx.rollback();throw error;}finally{await tx.close();}
  return true;
 }finally{await s.close();}
}
export async function deleteContextWebhooksForUser(tx:ManagedTransaction,userId:string) {
 await acquireContextAclLocks(tx,{userIds:[userId]});
 await tx.run(`MATCH (d:ContextWebhookDelivery) WHERE d.ownerUserId=$userId OR EXISTS {
  MATCH (r:ContextAgentRequest {id:d.requestId,requesterId:$userId}) } DETACH DELETE d`,{userId});
 await tx.run(`MATCH (w:ContextWebhook {ownerUserId:$userId}) DETACH DELETE w`,{userId});
}
export async function cleanupContextWebhooks(driver:Driver) {
 const s=driver.session();try{
  await s.run(`MATCH (d:ContextWebhookDelivery) WHERE d.expiresAt < $cutoff DETACH DELETE d`,{cutoff:new Date(Date.now()-7*86400_000).toISOString()});
  await s.run(`MATCH (w:ContextWebhook) WHERE NOT EXISTS {MATCH (:User {id:w.ownerUserId})} OR NOT EXISTS {MATCH (:AgentKey {id:w.agentKeyId})} DETACH DELETE w`);
 }finally{await s.close();}
}
export function startContextWebhookWorker(driver:Driver) {
 let stopped=false,busy=false,ticks=0;
 const tick=async()=>{if(stopped||busy)return;busy=true;try{if(ticks++%120===0)await cleanupContextWebhooks(driver);await runContextWebhookOnce(driver);}catch{console.warn('[context-webhooks] dispatch deferred');}finally{busy=false;}};
 const timer=setInterval(()=>void tick(),5000);timer.unref();return ()=>{stopped=true;clearInterval(timer);};
}
