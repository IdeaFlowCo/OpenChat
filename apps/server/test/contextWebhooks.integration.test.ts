import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import neo4j,{type Driver} from 'neo4j-driver';
import {createContextPost,updateContextPost} from '../src/services/contextLane.js';
import {askContextAgents,listContextAgentRequests} from '../src/services/contextAgentRequests.js';
import {createContextWebhook,deleteContextWebhook,listContextWebhooks,ensureContextWebhookIndexes,runContextWebhookOnce,contextWakeEnvelope,validateContextWebhookUrl,deleteContextWebhooksForUser,cleanupContextWebhooks} from '../src/services/contextWebhooks.js';
import {deliverContextWebhookOnce} from '../src/services/webhookDispatch.js';
const integration=process.env.NEO4J_TEST_URI?describe.sequential:describe.skip;
describe('Context webhook transport contract',()=>{
 it('signs timestamp and body without raw secret or content',()=>{const e=contextWakeEnvelope('event','request','secret',123000);expect(JSON.parse(e.body)).toEqual({id:'event',event:'context.requested',requestId:'request'});expect(e.headers['X-OpenChat-Timestamp']).toBe('123');expect(JSON.stringify(e.headers)).not.toContain('secret');expect(e.headers['X-OpenChat-Signature']).not.toBe(contextWakeEnvelope('event','other','secret',123000).headers['X-OpenChat-Signature']);});
 it('blocks HTTP, credentials, fragments and private endpoints without network',async()=>{for(const url of ['http://example.com','https://user:secret@example.com','https://example.com/#x','not-url'])expect(()=>validateContextWebhookUrl(url)).toThrow();process.env.WEBHOOK_ALLOW_LOCAL='true';for(const url of ['https://127.0.0.1','https://[::1]','https://169.254.169.254','https://10.1.2.3','https://192.168.1.1'])expect(await deliverContextWebhookOnce(url,{},'{}')).toBe('blocked');delete process.env.WEBHOOK_ALLOW_LOCAL;});
});
integration('Context wake durable outbox with fake transport',()=>{
 let driver:Driver;const prefix='wake-test-'+crypto.randomUUID(),a=prefix+'a',b=prefix+'b',room=prefix+'room',key=prefix+'key';
 const session=async<T>(f:(s:any)=>Promise<T>)=>{const s=driver.session();try{return await f(s);}finally{await s.close();}};
 const run=(q:string,p:any={})=>session(s=>s.run(q,p)) as Promise<any>;
 const input=()=>({url:'https://example.com/context',conversationId:room,agentKeyId:key,clientRequestId:crypto.randomUUID(),consent:true});
 const setup=()=>session(s=>createContextWebhook(s,b,input()));
 async function queue(){const p=await session(s=>createContextPost(s,a,room,{text:'Shared request never in wake',clientRequestId:crypto.randomUUID()}));await session(s=>askContextAgents(s,a,room,p.id));return p;}
 const delivery=async()=>{const r=await run('MATCH (d:ContextWebhookDelivery {conversationId:$room}) RETURN d',{room});return r.records.map((r:any)=>r.get('d').properties);};
 beforeAll(async()=>{driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER||'neo4j',process.env.NEO4J_TEST_PASSWORD||'test'));await ensureContextWebhookIndexes(driver);});
 beforeEach(async()=>{process.env.OPENCHAT_CONTEXT_LANE='true';process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED='true';process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='false';await run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.ownerUserId IN [$a,$b] DETACH DELETE n`,{prefix,room,a,b});await run(`CREATE (a:User {id:$a}),(b:User {id:$b}),(c:Conversation {id:$room}),(k:AgentKey {id:$key,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true}) CREATE (a)-[:PARTICIPATES_IN]->(c),(b)-[:PARTICIPATES_IN]->(c)`,{a,b,room,key});});
 afterAll(async()=>{await run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.ownerUserId IN [$a,$b] DETACH DELETE n`,{prefix,room,a,b});await driver.close();delete process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED;delete process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED;});
 it('requires consent and owned live key, deduplicates concurrent creation',async()=>{await expect(session(s=>createContextWebhook(s,b,{...input(),consent:false}))).rejects.toMatchObject({statusCode:400});await expect(session(s=>createContextWebhook(s,a,input()))).rejects.toMatchObject({statusCode:403});const args=input();const [one,two]=await Promise.all([session(s=>createContextWebhook(s,b,args)),session(s=>createContextWebhook(s,b,args))]);expect(one.subscription.id).toBe(two.subscription.id);expect(one.secret).toBe(two.secret);expect(JSON.stringify(await session(s=>listContextWebhooks(s,b)))).not.toContain(one.secret);await expect(session(s=>createContextWebhook(s,b,{...input(),url:'https://other.example/'}))).rejects.toMatchObject({statusCode:409});});
 it('does not replay historical or duplicate requests; sends request ID only once',async()=>{await queue();expect(await delivery()).toHaveLength(0);await setup();const post=await queue();await session(s=>askContextAgents(s,a,room,post.id));expect(await delivery()).toHaveLength(1);const fake=vi.fn(async(..._args:any[])=>true);expect(await runContextWebhookOnce(driver,fake)).toBe(true);expect(fake).toHaveBeenCalledTimes(1);expect(fake.mock.calls[0][2]).not.toContain('Shared request');expect(Object.keys(JSON.parse(fake.mock.calls[0][2]))).toEqual(['id','event','requestId']);expect((await delivery())[0].status).toBe('delivered');expect(await runContextWebhookOnce(driver,fake)).toBe(false);});
 it('cancels after edits and unsubscribe',async()=>{const sub=await setup();const p=await queue();await session(s=>updateContextPost(s,a,room,p.id,'Edited',p.revision));const fake=vi.fn(async()=>true);await runContextWebhookOnce(driver,fake);expect(fake).not.toHaveBeenCalled();expect((await delivery())[0].status).toBe('cancelled');await queue();await session(s=>deleteContextWebhook(s,b,sub.subscription.id));expect(await runContextWebhookOnce(driver,fake)).toBe(false);});
 for(const [label,mutation] of [
  ['revoked key',`MATCH (k:AgentKey {id:$key}) SET k.revokedAt='now'`],
  ['key opt-out',`MATCH (k:AgentKey {id:$key}) SET k.contextRequestsEnabled=false`],
  ['owner left',`MATCH (:User {id:$b})-[p:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE p`],
  ['requester left',`MATCH (:User {id:$a})-[p:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE p`],
  ['block',`MATCH (a:User {id:$a}),(b:User {id:$b}) CREATE (a)-[:BLOCKED]->(b)`],
  ['fulfilled',`MATCH (t:Thought {conversationId:$room,lane:'context'}) SET t.intentionState='fulfilled'`],
  ['completed',`MATCH (r:ContextAgentRequest {conversationId:$room}) SET r.status='completed'`],
 ])it('rechecks '+label+' before send',async()=>{await setup();await queue();await run(mutation,{key,a,b,room});const fake=vi.fn(async()=>true);await runContextWebhookOnce(driver,fake);expect(fake).not.toHaveBeenCalled();expect((await delivery())[0].status).toBe('cancelled');});
 it('leases once and retries at most four times with stable event identity',async()=>{await setup();await queue();const fake=vi.fn(async(..._args:any[])=>false);await Promise.all([runContextWebhookOnce(driver,fake),runContextWebhookOnce(driver,fake)]);expect(fake).toHaveBeenCalledTimes(1);for(let i=0;i<3;i++){await run(`MATCH (d:ContextWebhookDelivery {conversationId:$room}) SET d.nextAttemptAt='2000-01-01'`,{room});await runContextWebhookOnce(driver,fake);}expect(fake).toHaveBeenCalledTimes(4);expect(new Set(fake.mock.calls.map(c=>JSON.parse(c[2]).id)).size).toBe(1);expect((await delivery())[0].status).toBe('failed');expect(await runContextWebhookOnce(driver,fake)).toBe(false);});
 it('recovers abandoned leases, honors kill switch and expiry',async()=>{await setup();await queue();await run(`MATCH (d:ContextWebhookDelivery {conversationId:$room}) SET d.status='delivering',d.leaseUntil='2000-01-01',d.attempts=1`,{room});const fake=vi.fn(async()=>true);process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED='false';expect(await runContextWebhookOnce(driver,fake)).toBe(false);process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED='true';await runContextWebhookOnce(driver,fake);expect(fake).toHaveBeenCalledTimes(1);await queue();await run(`MATCH (d:ContextWebhookDelivery {conversationId:$room,status:'pending'}) SET d.expiresAt='2000-01-01'`,{room});await runContextWebhookOnce(driver,fake);expect(fake).toHaveBeenCalledTimes(1);expect((await delivery()).some((d:any)=>d.status==='expired')).toBe(true);});
 it('account deletion immediately removes owned secrets/deliveries and requester-linked wake receipts',async()=>{
  await setup();await queue();expect(await delivery()).toHaveLength(1);
  await session(s=>s.executeWrite((tx:any)=>deleteContextWebhooksForUser(tx,a)));
  expect(await delivery()).toEqual([]);expect((await session(s=>listContextWebhooks(s,b))).subscriptions).toHaveLength(1);
  await queue();expect(await delivery()).toHaveLength(1);
  await session(s=>s.executeWrite((tx:any)=>deleteContextWebhooksForUser(tx,b)));
  expect(await delivery()).toEqual([]);expect((await session(s=>listContextWebhooks(s,b))).subscriptions).toEqual([]);
  const fake=vi.fn(async()=>true);expect(await runContextWebhookOnce(driver,fake)).toBe(false);expect(fake).not.toHaveBeenCalled();
 });

 it('routes the configured later key instead of the first opted-in key, with one wake',async()=>{
  const earlier=prefix+'aaa';await run(`CREATE (:AgentKey {id:$earlier,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true})`,{earlier,b});
  expect((await setup()).subscription.routingStatus).toBe('ready');
  await queue();
  expect((await session(s=>listContextAgentRequests(s,b,earlier))).requests).toEqual([]);
  expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(1);
  const fake=vi.fn(async()=>true);await runContextWebhookOnce(driver,fake);expect(fake).toHaveBeenCalledTimes(1);
 });
 it('serializes conflicting receiver setup per owner and conversation',async()=>{
  const other=prefix+'other';await run(`CREATE (:AgentKey {id:$other,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true})`,{other,b});
  const results=await Promise.allSettled([setup(),session(s=>createContextWebhook(s,b,{...input(),agentKeyId:other}))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{statusCode:409}});
  expect((await session(s=>listContextWebhooks(s,b))).subscriptions).toHaveLength(1);
 });
 for(const [label,mutation] of [
  ['revoked',`SET k.revokedAt='now'`],['expired',`SET k.expiresAt='2000-01-01'`],
  ['opted out',`SET k.contextRequestsEnabled=false`],['missing opt-in',`REMOVE k.contextRequestsEnabled`],['read only',`SET k.scopes=['read']`],['deleted',`DETACH DELETE k`],
 ])it('suspends a saved '+label+' receiver without switching to another opted-in key',async()=>{
  const other=prefix+'aaa';await run(`CREATE (:AgentKey {id:$other,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true})`,{other,b});
  await setup();await run(`MATCH (k:AgentKey {id:$key}) `+mutation,{key});await cleanupContextWebhooks(driver);
  expect((await session(s=>listContextWebhooks(s,b))).subscriptions[0].routingStatus).toBe('key_ineligible');
  const p=await session(s=>createContextPost(s,a,room,{text:'request',clientRequestId:crypto.randomUUID()}));
  await expect(session(s=>askContextAgents(s,a,room,p.id))).rejects.toMatchObject({statusCode:409});
  expect((await session(s=>listContextAgentRequests(s,b,other))).requests).toEqual([]);expect(await delivery()).toEqual([]);
 });
 it('does not route a receiving key to itself or fall back to a different key',async()=>{
  await setup();await run(`CREATE (:AgentKey {id:$other,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true})`,{other:prefix+'aaa',b});
  const p=await session(s=>createContextPost(s,b,room,{text:'self request',clientRequestId:crypto.randomUUID()}));
  await expect(session(s=>askContextAgents(s,b,room,p.id,key,['read','write']))).rejects.toMatchObject({statusCode:409});
  expect(await delivery()).toEqual([]);
 });
 it('fails closed for ambiguous legacy saved receivers, including pending deliveries',async()=>{
  const sub=await setup();await queue();
  await run(`MATCH (w:ContextWebhook {id:$id}) CREATE (other:ContextWebhook) SET other=w {.*,id:$other,clientRequestId:$other}`,{id:sub.subscription.id,other:prefix+'legacy'});
  expect((await session(s=>listContextWebhooks(s,b))).subscriptions.map((w:any)=>w.routingStatus)).toEqual(['conflict','conflict']);
  await expect(setup()).rejects.toMatchObject({statusCode:409});
  await expect(queue()).rejects.toMatchObject({statusCode:409});
  const fake=vi.fn(async()=>true);await runContextWebhookOnce(driver,fake);expect(fake).not.toHaveBeenCalled();
 });
 it('reports hosted precedence, unavailable conversation, global disable, and explicit disable',async()=>{
  const savedKey=process.env.ANTHROPIC_API_KEY;
  try {
   process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='true';process.env.ANTHROPIC_API_KEY='synthetic-provider-never-called';
   await run(`MATCH (u:User {id:$b}) SET u.contextHostedEnabled=true,u.contextHostedGeneration=1`,{b});
   const sub=await setup();expect(sub.subscription.routingStatus).toBe('hosted_precedence');
   await queue();expect(await delivery()).toEqual([]);
   const requests=await run(`MATCH (r:ContextAgentRequest {ownerUserId:$b}) RETURN r.recipientType AS type`,{b});
   expect(requests.records.map((r:any)=>r.get('type'))).toEqual(['hosted']);
   await run(`MATCH (:User {id:$b})-[m:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE m`,{b,room});
   expect((await session(s=>listContextWebhooks(s,b))).subscriptions[0].routingStatus).toBe('conversation_unavailable');
   process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED='false';
   expect((await session(s=>listContextWebhooks(s,b))).subscriptions[0].routingStatus).toBe('server_disabled');
   await session(s=>deleteContextWebhook(s,b,sub.subscription.id));
   expect((await session(s=>listContextWebhooks(s,b))).subscriptions[0].routingStatus).toBe('disabled');
  }finally{if(savedKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=savedKey;}
 });
 it('never reassigns or replays an existing owner/source revision after a receiver switch',async()=>{
  const sub=await setup(),p=await queue(),other=prefix+'aaa';
  await session(s=>deleteContextWebhook(s,b,sub.subscription.id));
  await run(`CREATE (:AgentKey {id:$other,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true})`,{other,b});
  await session(s=>createContextWebhook(s,b,{...input(),agentKeyId:other}));
  expect((await session(s=>askContextAgents(s,a,room,p.id))).queued).toBe(0);
  expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(1);
  expect((await session(s=>listContextAgentRequests(s,b,other))).requests).toEqual([]);
  expect(await delivery()).toHaveLength(1);expect((await delivery())[0].status).toBe('cancelled');
  await session(s=>updateContextPost(s,a,room,p.id,'New revision',p.revision));
  expect((await session(s=>askContextAgents(s,a,room,p.id))).queued).toBe(1);
  expect((await session(s=>listContextAgentRequests(s,b,other))).requests).toHaveLength(1);
 });
 it('deduplicates the same owner/source revision across external and hosted receivers',async()=>{
  const savedKey=process.env.ANTHROPIC_API_KEY;
  try{
   await setup();const p=await queue();
   process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='true';process.env.ANTHROPIC_API_KEY='synthetic-provider-never-called';
   await run(`MATCH (u:User {id:$b}) SET u.contextHostedEnabled=true,u.contextHostedGeneration=1`,{b});
   expect((await session(s=>askContextAgents(s,a,room,p.id))).queued).toBe(0);
   await session(s=>updateContextPost(s,a,room,p.id,'New hosted revision',p.revision));
   expect((await session(s=>askContextAgents(s,a,room,p.id))).queued).toBe(1);
   await run(`MATCH (u:User {id:$b}) SET u.contextHostedEnabled=false`,{b});
   expect((await session(s=>askContextAgents(s,a,room,p.id))).queued).toBe(0);
   const r=await run(`MATCH (r:ContextAgentRequest {ownerUserId:$b}) RETURN count(r) AS count`,{b});expect(Number(r.records[0].get('count'))).toBe(2);
  }finally{if(savedKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=savedKey;}
 });

 it('cancels an undelivered wake when hosted takes precedence, preserving original key ownership',async()=>{
  const savedKey=process.env.ANTHROPIC_API_KEY;
  try{
   await setup();const p=await queue();
   process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='true';process.env.ANTHROPIC_API_KEY='synthetic-provider-never-called';
   await run(`MATCH (u:User {id:$b}) SET u.contextHostedEnabled=true,u.contextHostedGeneration=1`,{b});
   expect((await session(s=>listContextWebhooks(s,b))).subscriptions[0].routingStatus).toBe('hosted_precedence');
   const fake=vi.fn(async()=>true);await runContextWebhookOnce(driver,fake);expect(fake).not.toHaveBeenCalled();
   expect((await delivery())[0].status).toBe('cancelled');
   expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toHaveLength(1);
   expect((await session(s=>askContextAgents(s,a,room,p.id))).queued).toBe(0);
  }finally{if(savedKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=savedKey;}
 });

});
