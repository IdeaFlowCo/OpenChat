import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import neo4j,{type Driver} from 'neo4j-driver';
import {createContextPost,listContextPosts,updateContextPost} from '../src/services/contextLane.js';
import {askContextAgents,contextAgentPreference} from '../src/services/contextAgentRequests.js';
import {ensureHostedContextIndexes,hostedPreference,listHostedRequests,getHostedRequest,runHostedContextOnce,reviseHostedRequest,publishHostedRequest,stopHostedRequest,cleanupExpiredHostedContext,deleteHostedContextForUser} from '../src/services/contextHosted.js';
const integration=process.env.NEO4J_TEST_URI?describe.sequential:describe.skip;
integration('hosted Context private review with real Neo4j and fake model',()=>{
 let driver:Driver;
 const prefix='hosted-test-'+crypto.randomUUID(),a=prefix+'-a',b=prefix+'-b',room=prefix+'-room',key=prefix+'-key';
 const session=async<T>(fn:(s:any)=>Promise<T>)=>{const s=driver.session();try{return await fn(s);}finally{await s.close();}};
 const run=(q:string,p:any={})=>session(s=>s.run(q,p)) as Promise<any>;
 async function queued(text='Shared request'){
  const post=await session(s=>createContextPost(s,a,room,{text,clientRequestId:crypto.randomUUID()}));
  await session(s=>askContextAgents(s,a,room,post.id));
  return (await session(s=>listHostedRequests(s,b))).requests.find(r=>r.postId===post.id)!;
 }
 const approve=(r:any)=>({draftId:r.draft.id,approvalDigest:r.draft.approvalDigest,text:r.draft.text});
 beforeAll(async()=>{
  process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='true';process.env.OPENCHAT_CONTEXT_LANE='true';process.env.ANTHROPIC_API_KEY='test-only-never-used';
  driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER||'neo4j',process.env.NEO4J_TEST_PASSWORD||'test'));
  await ensureHostedContextIndexes(driver);
 });
 beforeEach(async()=>{
  await run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.ownerUserId IN [$a,$b] DETACH DELETE n`,{prefix,room,a,b});
  await run(`MATCH (w:ContextHostedWorker) DETACH DELETE w`);
  await run(`CREATE (a:User {id:$a,name:'Alice'}),(b:User {id:$b,name:'Bob'}),(c:Conversation {id:$room,title:'Synthetic room',type:'group',lastMessageAt:'before'}),
    (k:AgentKey {id:$key,ownerUserId:$b,name:'External',scopes:['read','write']})
    CREATE (a)-[:PARTICIPATES_IN {role:'owner',lastReadAt:'before'}]->(c),(b)-[:PARTICIPATES_IN {role:'member',lastReadAt:'before'}]->(c)`,{a,b,room,key});
  process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='true';
 });
 afterAll(async()=>{await run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.ownerUserId IN [$a,$b] DETACH DELETE n`,{prefix,room,a,b});await driver.close();delete process.env.ANTHROPIC_API_KEY;delete process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED;});
 it('is off by default, requires opt-in, and uses hosted recipient ahead of the same owner’s external key',async()=>{
  expect(await session(s=>hostedPreference(s,b))).toEqual({enabled:false,available:true});
  const post=await session(s=>createContextPost(s,a,room,{text:'Request',clientRequestId:'initial'}));
  await expect(session(s=>askContextAgents(s,a,room,post.id))).rejects.toMatchObject({statusCode:409});
  await session(s=>contextAgentPreference(s,b,key,true));await session(s=>hostedPreference(s,b,true));
  expect(await session(s=>askContextAgents(s,a,room,post.id))).toEqual({queued:1,available:1});
  const rows=await run('MATCH (r:ContextAgentRequest {conversationId:$room}) RETURN r',{room});
  expect(rows.records).toHaveLength(1);expect(rows.records[0].get('r').properties.recipientType).toBe('hosted');
  expect(await session(s=>askContextAgents(s,a,room,post.id))).toEqual({queued:0,available:1});
  await session(s=>hostedPreference(s,b,true));expect((await session(s=>listHostedRequests(s,b))).requests[0].status).toBe('queued');
 });
 it('generates privately with only shared input, immutable review and one quiet idempotent publication',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();
  const model=vi.fn(async()=> 'Proposed shared answer');expect(await runHostedContextOnce(driver,model)).toBe(true);
  expect(model.mock.calls[0][0]).toEqual({sourceText:'Shared request'});
  const review=await session(s=>getHostedRequest(s,b,q.id));expect(review.status).toBe('review');expect(review.audience.map(x=>x.id)).toEqual([a,b]);
  expect((await session(s=>listContextPosts(s,a,room))).posts).toHaveLength(1);
  await expect(session(s=>getHostedRequest(s,a,q.id))).rejects.toMatchObject({statusCode:404});
  await expect(session(s=>publishHostedRequest(s,b,q.id,{...approve(review),text:'Changed'}))).rejects.toMatchObject({statusCode:409});
  const [one,two]=await Promise.all([session(s=>publishHostedRequest(s,b,q.id,approve(review))),session(s=>publishHostedRequest(s,b,q.id,approve(review)))]);
  expect(one.publishedPostId).toBe(two.publishedPostId);expect(one.status).toBe('published');
  const posts=(await session(s=>listContextPosts(s,a,room))).posts;expect(posts).toHaveLength(2);expect(posts.find(p=>p.id===one.publishedPostId)?.agent?.name).toBe('OpenChat Agent (owner approved)');
  const state=await run(`MATCH (c:Conversation {id:$room})<-[p:PARTICIPATES_IN]-() OPTIONAL MATCH (m:Message {conversationId:$room}) RETURN c.lastMessageAt AS at,collect(DISTINCT p.lastReadAt) AS reads,count(m) AS count`,{room});
  expect(state.records[0].get('at')).toBe('before');expect(state.records[0].get('reads')).toEqual(['before']);expect(Number(state.records[0].get('count'))).toBe(0);
 });
 it('explicit private input is model-only until a human reviews, edit creates a new exact approval',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();
  await session(s=>reviseHostedRequest(s,b,q.id,{privateText:'Owner selected private material'}));
  const model=vi.fn(async()=> 'Draft using selected material');await runHostedContextOnce(driver,model);
  expect(model.mock.calls[0][0]).toEqual({sourceText:'Shared request',privateText:'Owner selected private material'});
  const old=await session(s=>getHostedRequest(s,b,q.id));expect(old.privateText).toBe('Owner selected private material');
  const edit=await session(s=>reviseHostedRequest(s,b,q.id,{text:'Only this approved excerpt'}));expect(edit.draft!.approvalDigest).not.toBe(old.draft!.approvalDigest);
  await expect(session(s=>publishHostedRequest(s,b,q.id,approve(old)))).rejects.toMatchObject({statusCode:409});
  const done=await session(s=>publishHostedRequest(s,b,q.id,approve(edit)));expect(done.privateText).toBeUndefined();
  expect((await session(s=>listContextPosts(s,a,room))).posts.some(p=>p.text==='Owner selected private material')).toBe(false);
 });
 it('rejects in-flight output after private-input changes and keeps one active lease on concurrent workers',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();let release!:(s:string)=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;});
  const pending=runHostedContextOnce(driver,async()=>{entered();return new Promise<string>(r=>{release=r;});});await started;
  expect(await runHostedContextOnce(driver,async()=>{throw Error('must not execute');})).toBe(false);
  await session(s=>reviseHostedRequest(s,b,q.id,{privateText:'New explicit input'}));release('Stale draft');await pending;
  const next=await session(s=>getHostedRequest(s,b,q.id));expect(next.status).toBe('queued');expect(next.draft).toBeUndefined();
  await runHostedContextOnce(driver,async input=>'Fresh '+input.privateText);expect((await session(s=>getHostedRequest(s,b,q.id))).draft!.text).toBe('Fresh New explicit input');
 });
 it('opt-out cancels old generations; re-enable permits a fresh request without reactivating old drafts',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();await runHostedContextOnce(driver,async()=> 'Pending approval');const review=await session(s=>getHostedRequest(s,b,q.id));
  await session(s=>hostedPreference(s,b,false));expect((await session(s=>getHostedRequest(s,b,q.id))).status).toBe('cancelled');
  await expect(session(s=>publishHostedRequest(s,b,q.id,approve(review)))).rejects.toMatchObject({statusCode:409});
  await session(s=>hostedPreference(s,b,true));expect(await session(s=>askContextAgents(s,a,room,q.postId))).toEqual({queued:1,available:1});
  expect((await session(s=>listHostedRequests(s,b))).requests.filter(r=>r.status==='queued')).toHaveLength(1);
 });
 it('source edits, audience changes and blocks invalidate review; inaccessible text is redacted',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();await runHostedContextOnce(driver,async()=> 'Draft');const review=await session(s=>getHostedRequest(s,b,q.id));
  await session(s=>updateContextPost(s,a,room,q.postId,'Changed source',1));
  let stale=await session(s=>getHostedRequest(s,b,q.id));expect(stale.status).toBe('unavailable');expect(stale.source.text).toBe('');expect(stale.audience).toEqual([]);expect(stale.draft).toBeUndefined();
  await expect(session(s=>publishHostedRequest(s,b,q.id,approve(review)))).rejects.toMatchObject({statusCode:409});
  const fresh=await queued('New source');await runHostedContextOnce(driver,async()=> 'New draft');const draft=await session(s=>getHostedRequest(s,b,fresh.id));
  await run('MATCH (a:User {id:$a}),(b:User {id:$b}) CREATE (a)-[:BLOCKED]->(b)',{a,b});
  await expect(session(s=>publishHostedRequest(s,b,fresh.id,approve(draft)))).rejects.toMatchObject({statusCode:409});
  await run('MATCH (:User {id:$a})-[r:BLOCKED]->(:User {id:$b}) DELETE r',{a,b});
  await run('MATCH (c:Conversation {id:$room}) CREATE (u:User {id:$id})-[:PARTICIPATES_IN]->(c)',{room,id:prefix+'-new-member'});
  stale=await session(s=>getHostedRequest(s,b,fresh.id));expect(stale.status).toBe('unavailable');
  await expect(session(s=>publishHostedRequest(s,b,fresh.id,approve(draft)))).rejects.toMatchObject({statusCode:409});
 });
 it('recovers expired leases, bounds retries and hourly spend, and respects the global switch',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();
  await run("MATCH (r:ContextAgentRequest {id:$id}) SET r.status='processing',r.leaseToken='crashed',r.leaseExpiresAt='2000-01-01',r.attempts=1",{id:q.id});
  const model=vi.fn(async()=>{throw Error('provider error containing private text');});await runHostedContextOnce(driver,model);
  expect((await session(s=>getHostedRequest(s,b,q.id))).error).not.toContain('private text');
  await run('MATCH (r:ContextAgentRequest {id:$id}) SET r.nextAttemptAt=null',{id:q.id});await runHostedContextOnce(driver,model);
  expect((await session(s=>getHostedRequest(s,b,q.id))).status).toBe('failed');expect(model).toHaveBeenCalledTimes(2);
  await session(s=>reviseHostedRequest(s,b,q.id,{privateText:''}));
  await run('MATCH (u:User {id:$b}) SET u.contextHostedHour=$hour,u.contextHostedCount=6',{b,hour:Math.floor(Date.now()/3600000)});
  expect(await runHostedContextOnce(driver,model)).toBe(false);expect(model).toHaveBeenCalledTimes(2);
  process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED='false';expect(await runHostedContextOnce(driver,model)).toBe(false);
  expect(await session(s=>hostedPreference(s,b))).toEqual({enabled:true,available:false});
 });
 it('declines and expiry clear private input/drafts without producing shared content',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();await session(s=>reviseHostedRequest(s,b,q.id,{privateText:'Private'}));await runHostedContextOnce(driver,async()=> 'Private draft');
  await session(s=>stopHostedRequest(s,b,q.id,'declined'));let row=(await run('MATCH (r:ContextAgentRequest {id:$id}) RETURN r',{id:q.id})).records[0].get('r').properties;expect(row.privateText).toBeUndefined();
  expect((await run('MATCH (d:ContextHostedDraft {requestId:$id}) RETURN d',{id:q.id})).records).toHaveLength(0);
  const later=await queued();await session(s=>reviseHostedRequest(s,b,later.id,{privateText:'Expires'}));await runHostedContextOnce(driver,async()=> 'Expires');
  await run("MATCH (r:ContextAgentRequest {id:$id}) SET r.expiresAt='2000-01-01'",{id:later.id});await cleanupExpiredHostedContext(driver);
  row=(await run('MATCH (r:ContextAgentRequest {id:$id}) RETURN r',{id:later.id})).records[0].get('r').properties;expect(row.status).toBe('expired');expect(row.privateText).toBeUndefined();
  expect((await session(s=>listContextPosts(s,a,room))).posts).toHaveLength(2);
 });
 it('purges superseded and ACL-invalid drafts, and source-account deletion removes other owners’ snapshots',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();await runHostedContextOnce(driver,async()=> 'Old private draft');
  const old=await session(s=>getHostedRequest(s,b,q.id));await session(s=>reviseHostedRequest(s,b,q.id,{text:'New draft'}));
  expect((await run('MATCH (d:ContextHostedDraft {id:$id}) RETURN d',{id:old.draft!.id})).records).toHaveLength(0);
  await run('MATCH (c:Conversation {id:$room}) SET c.title=$title',{room,title:'Changed destination name'});
  expect((await session(s=>getHostedRequest(s,b,q.id))).status).toBe('unavailable');
  await cleanupExpiredHostedContext(driver);expect((await run('MATCH (d:ContextHostedDraft {requestId:$id}) RETURN d',{id:q.id})).records).toHaveLength(0);
  const fresh=await queued();await runHostedContextOnce(driver,async()=> 'Another owner private draft');
  await session(s=>s.executeWrite((tx:any)=>deleteHostedContextForUser(tx,a)));
  expect((await run('MATCH (r:ContextAgentRequest {id:$id}) RETURN r',{id:fresh.id})).records).toHaveLength(0);
  expect((await run('MATCH (d:ContextHostedDraft {requestId:$id}) RETURN d',{id:fresh.id})).records).toHaveLength(0);
 });
 it('keeps active reviews ahead of terminal history, rejects expired drafts and checks access on publish retries',async()=>{
  await session(s=>hostedPreference(s,b,true));const q=await queued();await runHostedContextOnce(driver,async()=> 'Reply');const draft=await session(s=>getHostedRequest(s,b,q.id));
  await run(`MATCH (r:ContextAgentRequest {id:$id}) UNWIND range(1,55) AS n CREATE (old:ContextAgentRequest) SET old=properties(r),old.id=$prefix+toString(n),old.status='cancelled',old.createdAt=datetime()+duration('PT1H')`,{id:q.id,prefix:prefix+'-history'});
  expect((await session(s=>listHostedRequests(s,b))).requests[0].id).toBe(q.id);
  await run('MATCH (d:ContextHostedDraft {id:$id}) SET d.expiresAt=$past',{id:draft.draft!.id,past:'2000-01-01'});
  await expect(session(s=>publishHostedRequest(s,b,q.id,approve(draft)))).rejects.toMatchObject({statusCode:409});
  const revised=await session(s=>reviseHostedRequest(s,b,q.id,{text:'Fresh reviewed reply'}));await session(s=>publishHostedRequest(s,b,q.id,approve(revised)));
  await run('MATCH (:User {id:$b})-[p:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE p',{b,room});
  await expect(session(s=>publishHostedRequest(s,b,q.id,approve(revised)))).rejects.toMatchObject({statusCode:409});
 });

 it('bounds processing to two durable leases and discards output after in-flight opt-out',async()=>{
  await session(s=>hostedPreference(s,b,true));await queued('One');await queued('Two');await queued('Three');
  const releases:Array<(value:string)=>void>=[];let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const model=async()=>{const result=new Promise<string>(resolve=>{releases.push(resolve);if(releases.length===2)entered();});return result;};
  const first=runHostedContextOnce(driver,model),second=runHostedContextOnce(driver,model);await started;
  expect(await runHostedContextOnce(driver,async()=>{throw Error('third lease must not execute');})).toBe(false);
  await session(s=>hostedPreference(s,b,false));releases.forEach(release=>release('Must remain discarded'));await Promise.all([first,second]);
  expect((await session(s=>listHostedRequests(s,b))).requests.every(r=>r.status==='cancelled'&&!r.draft)).toBe(true);
  expect((await session(s=>listContextPosts(s,a,room))).posts).toHaveLength(3);
 });

});
