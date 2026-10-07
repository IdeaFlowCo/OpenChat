import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import neo4j,{type Driver} from 'neo4j-driver';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {createCipheriv,randomBytes} from 'node:crypto';
const state=vi.hoisted(()=>({driver:null as any}));
vi.mock('../src/db.js',()=>({getDriver:()=>state.driver}));
import {createContextPost,deleteContextPost,listContextPosts,updateContextPost} from '../src/services/contextLane.js';
import {trackContextIntention,listContextIntentions,updateContextIntention} from '../src/services/contextIntentions.js';
import {askContextAgents,listContextAgentRequests,respondToContextAgentRequest} from '../src/services/contextAgentRequests.js';
import {scanIntentForMatches,withdrawIntent} from '../src/services/agentNetwork.js';
import {connectorOperationGuard} from '../src/routes/ideaflowConnector.js';
import {issueConnectorOperation} from '../src/lib/ideaflowConnector.js';
import routes from '../src/routes/contextIntentions.js';
import networkRoutes from '../src/routes/agentNetwork.js';
import {updateStory} from '../src/services/agentSocialLayer.js';
const integration=process.env.NEO4J_TEST_URI?describe.sequential:describe.skip;
integration('Context canonical intention lifecycle with real Neo4j',()=>{
 let driver:Driver;
 const prefix='phaseb-life-'+crypto.randomUUID(),a=prefix+'-a',b=prefix+'-b',room=prefix+'-room';
 const session=async<T>(fn:(s:any)=>Promise<T>)=>{const s=driver.session();try{return await fn(s);}finally{await s.close();}};
 const run=(q:string,p:any={})=>session(s=>s.run(q,p)) as Promise<any>;
 const cleanup=()=>run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.ownerUserId IN [$a,$b] DETACH DELETE n`,{prefix,room,a,b});
 const post=()=>session(s=>createContextPost(s,a,room,{text:'Shared ask',kind:'ask',clientRequestId:crypto.randomUUID()}));
 const track=(p:any,intentId?:string)=>session(s=>trackContextIntention(s,a,room,p.id,{sourceRevision:p.revision,clientRequestId:'track-'+p.id,...(intentId?{intentId}:{})}));
 beforeAll(()=>{driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER||'neo4j',process.env.NEO4J_TEST_PASSWORD||'test'));state.driver=driver;process.env.OPENCHAT_CONTEXT_LANE='true';process.env.JWT_SECRET='synthetic-phaseb-session-secret';});
 beforeEach(async()=>{await cleanup();await run(`CREATE (a:User {id:$a,name:'Alice'}),(b:User {id:$b,name:'Bob'}),(c:Conversation {id:$room,name:'Synthetic room',type:'group',lastMessageAt:'before'})
   CREATE (a)-[:PARTICIPATES_IN {role:'owner',lastReadAt:'before'}]->(c),(b)-[:PARTICIPATES_IN {role:'member',lastReadAt:'before'}]->(c)`,{a,b,room});});
 afterAll(async()=>{await cleanup();await driver.close();});
 it('tracks explicitly once under concurrency, leaves network and Stories off, and exposes only safe shared summary',async()=>{
  const p=await post();const [left,right]=await Promise.all([track(p),track(p)]);expect(left.intention.intentId).toBe(right.intention.intentId);
  expect(left.intention).toMatchObject({searchStatus:'paused',contextOnly:true,lifecycleState:'open',kind:'ask'});expect(left.intention.stories).toEqual([]);
  expect((await session(s=>listContextIntentions(s,a))).intentions).toHaveLength(1);
  expect((await session(s=>listContextIntentions(s,b))).intentions).toEqual([]);
  const shared=(await session(s=>listContextPosts(s,b,room))).posts[0];expect(shared.intention?.intentId).toBe(left.intention.intentId);expect(shared.intention).not.toHaveProperty('goal');
  expect(left.intention.contextPosts[0].conversationTitle).toBe('Synthetic room');
  const quiet=await run(`MATCH (c:Conversation {id:$room})<-[p:PARTICIPATES_IN]-() OPTIONAL MATCH (m:Message {conversationId:$room}) RETURN c.lastMessageAt AS at,collect(DISTINCT p.lastReadAt) AS reads,count(m) AS count`,{room});
  expect(quiet.records[0].get('at')).toBe('before');expect(quiet.records[0].get('reads')).toEqual(['before']);expect(Number(quiet.records[0].get('count'))).toBe(0);
 });
 it('links an existing canonical Story intent without copying private details or changing approved search audience',async()=>{
  const id=prefix+'-existing',story=prefix+'-story';await run(`MATCH (u:User {id:$a}) CREATE (i:AgentIntent {id:$id,ownerUserId:$a,kind:'ask',terms:'Private terms',goal:'Private goal',details:'Secret',status:'active',audienceRestricted:true,audienceUserIds:[$b],audienceConversationIds:[],createdAt:datetime(),updatedAt:datetime()})
   CREATE (s:OpenChatStory {id:$story,ownerUserId:$a,intentId:$id,text:'Approved Story',status:'active',humanVisible:true}) CREATE (u)-[:OWNS_INTENT]->(i),(u)-[:OWNS_STORY]->(s),(s)-[:ACTIVATES]->(i)`,{a,b,id,story});
  const p=await post(),linked=await track(p,id);expect(linked.intention.intentId).toBe(id);expect(linked.intention.searchStatus).toBe('active');expect(linked.intention.stories).toHaveLength(1);
  const shared=(await session(s=>listContextPosts(s,b,room))).posts[0];expect(shared.text).toBe('Shared ask');expect(JSON.stringify(shared)).not.toContain('Private');
  const node=(await run('MATCH (i:AgentIntent {id:$id}) RETURN i',{id})).records[0].get('i').properties;expect(node.audienceUserIds).toEqual([b]);expect(node.audienceConversationIds).toEqual([]);
 });
 it('Story withdrawal reconciles a linked legacy intention and repeated closure repairs stale projections',async()=>{
  const id=prefix+'-existing',story=prefix+'-story';
  await run(`MATCH (u:User {id:$a}) CREATE (i:AgentIntent {id:$id,ownerUserId:$a,kind:'ask',status:'active',createdAt:datetime()})
   CREATE (s:OpenChatStory {id:$story,ownerUserId:$a,intentId:$id,text:'Approved Story',status:'active',humanVisible:true,agentSearchEnabled:true,explicitQuietSearch:false})
   CREATE (u)-[:OWNS_INTENT]->(i),(u)-[:OWNS_STORY]->(s),(s)-[:ACTIVATES]->(i)`,{a,id,story});
  const p=await post();await track(p,id);
  await updateStory(a,story,{status:'withdrawn'});
  let inventory=(await session(s=>listContextIntentions(s,a))).intentions[0];
  expect(inventory.lifecycleState).toBe('withdrawn');expect(inventory.contextPosts[0].post.status).toBe('closed');
  await expect(session(s=>askContextAgents(s,a,room,p.id))).rejects.toMatchObject({statusCode:404});
  await run(`MATCH (t:Thought {id:$postId}) SET t.status='open',t.intentionState='open'`,{postId:p.id});
  inventory=(await session(s=>updateContextIntention(s,a,id,{expectedRevision:inventory.revision,lifecycleState:'withdrawn'}))).intention;
  expect(inventory.contextPosts[0].post.status).toBe('closed');expect(inventory.contextPosts[0].post.intention?.lifecycleState).toBe('withdrawn');
 });
 it('fulfills every linked projection; reopening never resumes matching or a withdrawn Story',async()=>{
  const p=await post(),linked=await track(p),id=linked.intention.intentId;
  await run(`MATCH (u:User {id:$a}),(i:AgentIntent {id:$id}) CREATE (s:OpenChatStory {id:$story,ownerUserId:$a,intentId:$id,status:'active',text:'Approved'}) CREATE (u)-[:OWNS_STORY]->(s),(s)-[:ACTIVATES]->(i)`,{a,id,story:prefix+'-story'});
  const done=await session(s=>updateContextIntention(s,a,id,{expectedRevision:linked.intention.revision,lifecycleState:'fulfilled'}));expect(done.intention.searchStatus).toBe('withdrawn');expect(done.intention.contextPosts[0].post.status).toBe('closed');expect(done.intention.stories[0].status).toBe('withdrawn');
  await expect(session(s=>askContextAgents(s,a,room,p.id))).rejects.toMatchObject({statusCode:404});
  await expect(session(s=>updateContextIntention(s,a,id,{expectedRevision:linked.intention.revision,lifecycleState:'open'}))).rejects.toMatchObject({statusCode:409});
  const reopened=await session(s=>updateContextIntention(s,a,id,{expectedRevision:done.intention.revision,lifecycleState:'open'}));expect(reopened.intention.searchStatus).toBe('paused');expect(reopened.intention.stories[0].status).toBe('withdrawn');expect(reopened.intention.contextPosts[0].post.revision).toBeGreaterThan(done.intention.contextPosts[0].post.revision);
 });
 it('preserves identity on edits/deletes and hides inaccessible source projections',async()=>{
  const p=await post(),linked=await track(p),id=linked.intention.intentId;
  const edited=await session(s=>updateContextPost(s,a,room,p.id,'Changed shared text',2));expect(edited.intention).toMatchObject({intentId:id,sourceChanged:true});
  expect((await session(s=>listContextIntentions(s,a))).intentions[0].goal).toBe('Shared ask');
  const second=await post();await track(second,id);await session(s=>deleteContextPost(s,a,room,p.id));
  let inventory=(await session(s=>listContextIntentions(s,a))).intentions[0];expect(inventory.intentId).toBe(id);expect(inventory.contextPosts).toHaveLength(1);expect(inventory.lifecycleState).toBe('open');
  await run('MATCH (:User {id:$a})-[p:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE p',{a,room});
  inventory=(await session(s=>listContextIntentions(s,a))).intentions[0];expect(inventory.contextPosts).toEqual([]);
  const done=await session(s=>updateContextIntention(s,a,id,{expectedRevision:inventory.revision,lifecycleState:'withdrawn'}));
  await expect(session(s=>updateContextIntention(s,a,id,{expectedRevision:done.intention.revision,lifecycleState:'open'}))).rejects.toMatchObject({statusCode:409});
 });
 it('rejects stale, foreign and non-typed sources and conflicting canonical reassignment',async()=>{
  const p=await post();await expect(session(s=>trackContextIntention(s,b,room,p.id,{sourceRevision:1,clientRequestId:'foreign'}))).rejects.toMatchObject({statusCode:404});
  await expect(session(s=>trackContextIntention(s,a,room,p.id,{sourceRevision:3,clientRequestId:'stale'}))).rejects.toMatchObject({statusCode:409});
  const linked=await track(p);await expect(track({...p,revision:2},prefix+'-another')).rejects.toMatchObject({statusCode:409});
  expect((await session(s=>listContextIntentions(s,a))).intentions[0].intentId).toBe(linked.intention.intentId);
  const note=await session(s=>createContextPost(s,a,room,{text:'Note',clientRequestId:crypto.randomUUID()}));await expect(track(note)).rejects.toMatchObject({statusCode:404});
 });
 it('excludes conversation-only intents from matching even if a legacy route makes their status active',async()=>{
  const linked=await track(await post()),id=linked.intention.intentId;await run(`MATCH (i:AgentIntent {id:$id}),(u:User {id:$b}) SET i.status='active'
   CREATE (other:AgentIntent {id:$other,ownerUserId:$b,kind:'offer',terms:'Shared ask',status:'active'}) CREATE (u)-[:OWNS_INTENT]->(other)`,{id,b,other:prefix+'-offer'});
  const score=vi.fn(async()=>1),verify=vi.fn(async()=>true);expect(await scanIntentForMatches(id,{scoring:{embeddingScore:score,verify,threshold:0}})).toEqual([]);expect(score).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
  expect(await scanIntentForMatches(prefix+'-offer',{scoring:{embeddingScore:score,verify,threshold:0}})).toEqual([]);expect(score).not.toHaveBeenCalled();
  await withdrawIntent(a,id);expect((await session(s=>listContextPosts(s,a,room))).posts[0].intention?.lifecycleState).toBe('withdrawn');
 });
 it('requires a real human session, rejecting key, genuine connector principal and embedded JWT',async()=>{
  const app=express();app.use(express.json());app.use('/api',connectorOperationGuard);app.use('/api/chat',routes);
  const token=jwt.sign({userId:a,email:'synthetic@example.invalid'},process.env.JWT_SECRET!);
  expect((await request(app).get('/api/chat/context-intentions').set('Authorization',`Bearer ${token}`)).status).toBe(200);
  expect((await request(app).get('/api/chat/context-intentions').set('Authorization','Bearer oc_synthetic')).status).toBe(401);
  const embedded=jwt.sign({userId:a,email:'synthetic@example.invalid',embedded:'unlinked'},process.env.JWT_SECRET!);
  expect((await request(app).get('/api/chat/context-intentions').set('Authorization',`Bearer ${embedded}`)).status).toBe(403);
  const operation=issueConnectorOperation(a,{method:'GET',path:'/api/chat/context-intentions'},['openchat:read']);
  expect((await request(app).get('/api/chat/context-intentions').set('Authorization',`Bearer ${operation}`)).status).toBe(401);
 });
 it('keeps old agent requests invalid after close/reopen and enforces the open-publication quota',async()=>{
  const linked=await track(await post()),id=linked.intention.intentId,p=linked.intention.contextPosts[0].post,key=prefix+'-key';
  await run(`CREATE (:AgentKey {id:$key,ownerUserId:$b,scopes:['read','write'],contextRequestsEnabled:true})`,{key,b});
  await session(s=>askContextAgents(s,a,room,p.id));const pending=(await session(s=>listContextAgentRequests(s,b,key))).requests[0];expect(pending).toBeDefined();
  const closed=await session(s=>updateContextIntention(s,a,id,{expectedRevision:linked.intention.revision,lifecycleState:'fulfilled'}));
  const opened=await session(s=>updateContextIntention(s,a,id,{expectedRevision:closed.intention.revision,lifecycleState:'open'}));
  expect((await session(s=>listContextAgentRequests(s,b,key))).requests).toEqual([]);
  await expect(session(s=>respondToContextAgentRequest(s,b,key,['read','write'],pending.id,'Must not publish'))).rejects.toMatchObject({statusCode:404});
  const again=await session(s=>updateContextIntention(s,a,id,{expectedRevision:opened.intention.revision,lifecycleState:'withdrawn'}));
  await run(`UNWIND range(1,50) AS n CREATE (:Thought {id:$prefix+toString(n),authorId:$a,userId:$a,conversationId:$room,lane:'context',kind:'ask',status:'open',text:'Synthetic quota',revision:1,createdAt:datetime(),updatedAt:datetime()})`,{prefix:prefix+'-quota-',a,room});
  await expect(session(s=>updateContextIntention(s,a,id,{expectedRevision:again.intention.revision,lifecycleState:'open'}))).rejects.toMatchObject({statusCode:429});
 });

 it('denies a real read-only agent key on legacy withdrawal of a tracked shared intention',async()=>{
  const linked=await track(await post()),id=linked.intention.intentId;
  const encryption=randomBytes(32),iv=randomBytes(12),key='oc_'+randomBytes(24).toString('base64url');process.env.OC_KEY_ENCRYPTION_SECRET=encryption.toString('hex');
  const cipher=createCipheriv('aes-256-gcm',encryption,iv),ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('hex');
  await run(`CREATE (:AgentKey {id:$id,ownerUserId:$a,keyPrefix:$prefix,keyCiphertext:$ciphertext,keyIv:$iv,scopes:['read']})`,{id:prefix+'-readonly',a,prefix:key.slice(0,11),ciphertext,iv:iv.toString('hex')});
  const app=express();app.use(express.json());app.use('/api/agent',networkRoutes);
  expect((await request(app).get('/api/agent/intents').set('Authorization',`Bearer ${key}`)).status).toBe(200);
  expect((await request(app).patch('/api/agent/intents/'+id).set('Authorization',`Bearer ${key}`).send({status:'withdrawn'})).status).toBe(403);
  expect((await session(s=>listContextIntentions(s,a))).intentions[0].lifecycleState).toBe('open');
 });

 it('legacy Story resume cannot revive a closed canonical intention or race past lifecycle closure',async()=>{
  const linked=await track(await post()),id=linked.intention.intentId,story=prefix+'-legacy-story';
  await run(`MATCH (u:User {id:$a}),(i:AgentIntent {id:$id}) CREATE (s:OpenChatStory {id:$story,ownerUserId:$a,intentId:$id,status:'paused',text:'Approved story',humanVisible:true,agentSearchEnabled:true,explicitQuietSearch:false,storyExpiresAt:datetime()+duration('P1D')}) CREATE (u)-[:OWNS_STORY]->(s),(s)-[:ACTIVATES]->(i)`,{a,id,story});
  for(const state of ['fulfilled','withdrawn']){
   // Model a preexisting inconsistent projection from an older writer: the
   // canonical lifecycle itself must stop resume, not only story.withdrawn.
   await run(`MATCH (i:AgentIntent {id:$id}),(s:OpenChatStory {id:$story}) SET i.lifecycleState=$state,i.status='withdrawn',s.status='paused'`,{id,story,state});
   expect(await updateStory(a,story,{status:'active'})).toBeNull();
   expect((await run('MATCH (s:OpenChatStory {id:$story}) RETURN s.status AS status',{story})).records[0].get('status')).toBe('paused');
  }
  await run(`MATCH (i:AgentIntent {id:$id}),(s:OpenChatStory {id:$story}) SET i.lifecycleState='open',i.status='paused',s.status='paused'`,{id,story});
  await Promise.all([updateStory(a,story,{status:'active'}),session(s=>updateContextIntention(s,a,id,{expectedRevision:linked.intention.revision,lifecycleState:'fulfilled'}))]);
  const final=(await session(s=>listContextIntentions(s,a))).intentions[0];expect(final.lifecycleState).toBe('fulfilled');expect(final.stories[0].status).toBe('withdrawn');expect(final.searchStatus).toBe('withdrawn');
  const reopened=await session(s=>updateContextIntention(s,a,id,{expectedRevision:final.revision,lifecycleState:'open'}));expect(reopened.intention.searchStatus).toBe('paused');
  expect(await updateStory(a,story,{status:'active'})).toBeNull();expect((await session(s=>listContextIntentions(s,a))).intentions[0].stories[0].status).toBe('withdrawn');
 });

});
