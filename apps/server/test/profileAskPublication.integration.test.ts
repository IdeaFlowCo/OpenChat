import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import neo4j,{type Driver} from 'neo4j-driver';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const state=vi.hoisted(()=>({driver:null as any}));
vi.mock('../src/db.js',()=>({getDriver:()=>state.driver}));
import {listProfileAsks,mutateProfileAsk,profileAskAudience,publishProfileAsk} from '../src/services/profileAsks.js';
import {listOwnedStories,listStoryFeed,updateStory} from '../src/services/agentSocialLayer.js';
import {updateContextIntention} from '../src/services/contextIntentions.js';
import messagingRoutes from '../src/routes/unlinkedMessaging.js';
import routes,{PROFILE_ASK_ISSUER} from '../src/routes/profileAsks.js';
const integration=process.env.NEO4J_TEST_URI?describe.sequential:describe.skip;
integration('canonical profile asks: real graph permissions and lifecycle',()=>{
 let driver:Driver;
 const prefix='profile-asks-fixture-'+randomUUID(),a=prefix+'-a',b=prefix+'-b',outsider=prefix+'-c',room=prefix+'-room';
 const session=async<T>(fn:(s:any)=>Promise<T>)=>{const s=driver.session();try{return await fn(s);}finally{await s.close();}};
 const run=(q:string,p:any={})=>session(s=>s.run(q,p)) as Promise<any>;
 const cleanup=()=>run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.ownerUserId IN [$a,$b,$outsider] DETACH DELETE n`,{prefix,a,b,outsider});
 const input=(visibility='public',extra:any={})=>({text:'Synthetic solar founders ask',visibility,expiresAt:new Date(Date.now()+86400000).toISOString(),userIds:[],conversationIds:[],...extra});
 const publish=(data:any=input())=>session(s=>publishProfileAsk(s,a,data));
 const read=(viewer:string|null,id?:string)=>session(s=>listProfileAsks(s,a,viewer,id??null));
 const edit=(ask:any,data:any)=>session(s=>mutateProfileAsk(s,a,ask.id,'edit',{...data,expectedRevision:ask.revision}));
 const app=express();app.use(express.json());app.use('/api',routes);app.use('/api',messagingRoutes);
 const identity=(subject:string)=>({issuer:PROFILE_ASK_ISSUER,subject});
 const post=(body:any)=>request(app).post('/api/unlinked/profile-asks').set('Authorization','Bearer '+ 'synthetic-service-secret-'.repeat(3)).send(body);
 beforeAll(()=>{driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER||'neo4j',process.env.NEO4J_TEST_PASSWORD||'test'));state.driver=driver;process.env.UNLINKED_MESSAGING_SECRET='synthetic-service-secret-'.repeat(3);});
 beforeEach(async()=>{await cleanup();await run(`CREATE (a:User {id:$a,name:'Same Name',ideaflowIssuer:$issuer,ideaflowSub:$a,ideaflowIdentityKey:$key}),
 (b:User {id:$b,name:'Same Name',ideaflowIssuer:$issuer,ideaflowSub:$b,ideaflowIdentityKey:$bKey}),(c:User {id:$outsider,name:'Same Name'}),
 (room:Conversation {id:$room,name:'Test group',type:'group'}),(connection:OpenChatConnection {id:$connection,firstId:$a,secondId:$b,state:'accepted'})
 CREATE (a)-[:PARTICIPATES_IN]->(room),(b)-[:PARTICIPATES_IN]->(room)`,{a,b,outsider,room,connection:prefix+'-connection',issuer:PROFILE_ASK_ISSUER,key:PROFILE_ASK_ISSUER+'\u001f'+a,bKey:PROFILE_ASK_ISSUER+'\u001f'+b});});
 afterAll(async()=>{await cleanup();await driver.close();});
 it('executes the confidential publication lifecycle through HTTP with canonical feed parity',async()=>{
  const transcript:any[]=[];
  const call=async(operation:string,extra:any={})=>{
   const response=await post({operation,owner:identity(a),viewer:identity(a),...extra});
   transcript.push({operation,status:response.status,body:response.body});
   expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
   return response.body;
  };
  const {ask}=await call('publish',{input:input('private')});
  expect((await call('list',{viewer:null})).asks).toEqual([]);
  const {ask:publicAsk}=await call('edit',{askId:ask.id,input:{...input(),expectedRevision:ask.revision}});
  const visible=(await call('list',{viewer:null})).asks;
  expect(visible).toHaveLength(1);expect(visible[0].id).toBe(ask.id);
  const feed=await listStoryFeed(b,a);
  expect(feed.map(s=>({id:s.id,text:s.text}))).toEqual(visible.map((s:any)=>({id:s.id,text:s.text})));
  transcript.push({canonicalFeed:feed.map(s=>({id:s.id,text:s.text}))});
  const {ask:closed}=await call('close',{askId:ask.id,input:{expectedRevision:publicAsk.revision}});
  expect((await call('list',{viewer:null})).asks).toEqual([]);
  expect(await listStoryFeed(b,a)).toEqual([]);
  await call('remove',{askId:ask.id,input:{expectedRevision:closed.revision}});
  expect((await call('list')).asks).toEqual([]);
  if(process.env.PROFILE_ASK_EVIDENCE_PATH) writeFileSync(process.env.PROFILE_ASK_EVIDENCE_PATH,JSON.stringify({fixture:'Synthetic personas only; confidential HTTP adapter and real isolated Neo4j',transcript},null,2));
 });
 it('requires explicit public permission, exposes a whitelisted DTO, and uses the same OpenChat feed',async()=>{
  const mine=await publish(input('private'));expect(await read(null)).toEqual([]);expect(await read(b)).toEqual([]);expect(await read(a)).toHaveLength(1);
  const shared=await publish();expect(await read(null)).toEqual([{id:shared.id,kind:'ask',text:shared.text,expiresAt:shared.expiresAt}]);
  expect((await listStoryFeed(b,a)).map(s=>s.id)).toEqual([shared.id]);
  const graph=await run(`MATCH (:User {id:$a})-[:OWNS_STORY]->(s:OpenChatStory)-[:ACTIVATES]->(i:AgentIntent) RETURN count(s) AS count,collect(i.status) AS statuses,collect(i.contextOnly) AS only`,{a});
  expect(graph.records[0].get('count').toNumber()).toBe(2);expect(graph.records[0].get('statuses')).toEqual(['paused','paused']);expect(graph.records[0].get('only')).toEqual([true,true]);
  expect((await read(a)).find(s=>s.id===mine.id)?.visibility).toBe('private');
 });
 it('keeps older active asks manageable beyond the bounded history',async()=>{
  const active=await publish();
  for(let n=0;n<51;n++){
   const closed=await publish();
   await session(s=>mutateProfileAsk(s,a,closed.id,'close',{expectedRevision:closed.revision}));
  }
  const inventory=await read(a);
  expect(inventory).toHaveLength(51);
  expect(inventory.find(s=>s.id===active.id)).toMatchObject({status:'active',revision:1});
  await session(s=>mutateProfileAsk(s,a,active.id,'remove',{expectedRevision:1}));
  expect(await read(null)).toEqual([]);
 },30000);
 it('rejects stale profile edits after shared Story and intention mutations',async()=>{
  const ask=await publish();
  const expiry=new Date(Date.now()+172800000).toISOString();
  await updateStory(a,ask.id,{storyExpiresAt:expiry});
  await expect(edit(ask,input())).rejects.toMatchObject({statusCode:409});
  const updated=(await read(a,ask.id))[0];
  expect(Date.parse(updated.expiresAt)).toBe(Date.parse(expiry));
  expect(updated.revision).toBeGreaterThan(ask.revision!);
  await updateStory(a,ask.id,{status:'paused'});
  await expect(edit(updated,input())).rejects.toMatchObject({statusCode:409});
  const paused=(await read(a,ask.id))[0];
  const owned=(await listOwnedStories(a)).find(s=>s.id===ask.id)!;
  await session(s=>updateContextIntention(s,a,owned.intentId,{expectedRevision:0,lifecycleState:'fulfilled'}));
  await expect(session(s=>mutateProfileAsk(s,a,ask.id,'remove',{expectedRevision:paused.revision}))).rejects.toMatchObject({statusCode:409});
  const closed=(await read(a,ask.id))[0];
  expect(closed.revision).toBeGreaterThan(paused.revision!);
  await session(s=>mutateProfileAsk(s,a,ask.id,'remove',{expectedRevision:closed.revision}));
 });
 it('preserves explicit visibility in the canonical owner inventory',async()=>{
  const publicAsk=await publish();
  const privateAsk=await publish(input('private'));
  const selectedAsk=await publish(input('selected',{userIds:[b]}));
  const inventory=await listOwnedStories(a);
  for(const [ask,visibility] of [[publicAsk,'public'],[privateAsk,'private'],[selectedAsk,'selected']] as const){
   expect(inventory.find(s=>s.id===ask.id)).toMatchObject({showOnProfile:true,profileVisibility:visibility});
  }
 });
 it('checks selected users/groups live, blocks both ways and does not grant permission through an empty DM',async()=>{
  const users=await publish(input('selected',{userIds:[b]}));expect((await read(b)).map(s=>s.id)).toContain(users.id);expect(await read(null)).toEqual([]);expect(await read(outsider)).toEqual([]);
  const groups=await publish(input('selected',{conversationIds:[room]}));expect((await read(b)).map(s=>s.id)).toContain(groups.id);
  await run('MATCH (b:User {id:$b})-[p:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE p',{b,room});expect((await read(b)).map(s=>s.id)).not.toContain(groups.id);
  await run('MATCH (a:User {id:$a}),(b:User {id:$b}) CREATE (b)-[:BLOCKED]->(a)',{a,b});expect(await read(b)).toEqual([]);expect(await listStoryFeed(b,a)).toEqual([]);
  await run('MATCH (a:User {id:$a}),(c:User {id:$outsider}) CREATE (dm:Conversation {id:$id,type:"direct"}) CREATE (a)-[:PARTICIPATES_IN]->(dm),(c)-[:PARTICIPATES_IN]->(dm)',{a,outsider,id:prefix+'-empty-dm'});
  expect(await read(outsider)).toEqual([]);
 });
 it('edits audience/text without making old private stories public; revocation invalidates old ask links',async()=>{
  const shared=await publish();const restricted=await edit(shared,input('selected',{text:'Changed approved ask',userIds:[b]}));
  expect(await read(null,shared.id)).toEqual([]);expect((await read(b,shared.id))[0].text).toBe('Changed approved ask');expect((await listStoryFeed(b,a))[0].text).toBe('Changed approved ask');
  await expect(edit(shared,input())).rejects.toMatchObject({statusCode:409});
  await expect(session(s=>mutateProfileAsk(s,b,shared.id,'close',{expectedRevision:restricted.revision}))).rejects.toMatchObject({statusCode:404});
  await run(`MATCH (a:User {id:$a}) CREATE (s:OpenChatStory {id:$id,status:'active',humanVisible:true,text:'Old private story',audienceUserIds:[$b],storyExpiresAt:datetime($expiry),createdAt:datetime()}) CREATE (a)-[:OWNS_STORY]->(s)`,{a,b,id:prefix+'-old-story',expiry:input().expiresAt});
  expect((await listStoryFeed(b,a)).some(s=>s.text==='Old private story')).toBe(true);expect((await read(b)).some(s=>s.text==='Old private story')).toBe(false);
 });
 it('close/remove and expiry affect both products; existing OpenChat lifecycle revokes publication',async()=>{
  const one=await publish();await session(s=>mutateProfileAsk(s,a,one.id,'close',{expectedRevision:1}));expect(await read(b)).toEqual([]);expect(await listStoryFeed(b,a)).toEqual([]);
  await expect(edit({...one,revision:2},input())).rejects.toMatchObject({statusCode:409});
  await session(s=>mutateProfileAsk(s,a,one.id,'remove',{expectedRevision:2}));expect(await read(a)).toEqual([]);
  const two=await publish();await updateStory(a,two.id,{status:'withdrawn'});expect(await read(b)).toEqual([]);
  const three=await publish();const rows=await run('MATCH (:OpenChatStory {id:$id})-[:ACTIVATES]->(i) RETURN i.id AS id',{id:three.id});
  await session(s=>updateContextIntention(s,a,rows.records[0].get('id'),{expectedRevision:0,lifecycleState:'fulfilled'}));expect(await read(null)).toEqual([]);
  const four=await publish();await run('MATCH (s:OpenChatStory {id:$id}) SET s.storyExpiresAt=datetime("2020-01-01")',{id:four.id});expect(await read(b,four.id)).toEqual([]);
 });
 it('addressed ask entry uses verified owner, refuses revoked/foreign ask IDs and sends nothing',async()=>{
  const ask=await publish(input('selected',{userIds:[b]}));
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({status:'member',name:'Same Name',identity:identity(a)})));
  const open=(askId:string,userId=b)=>request(app).post('/api/unlinked/recipient').auth(jwt.sign({userId,email:'fixture@example.invalid'},process.env.JWT_SECRET||'dev-secret-change-me'),{type:'bearer'}).send({profile:'https://www.unlinked.ai/people/fixture-profile',askId});
  try {
   const ready=await open(ask.id);expect(ready.status).toBe(200);expect(ready.body).toMatchObject({status:'ready',recipient:{id:a},ask:{id:ask.id,text:ask.text}});
   expect((await open(ask.id,outsider)).body).toEqual({status:'unavailable'});
   expect((await open('different-ask')).body).toEqual({status:'unavailable'});
   await edit(ask,input('private'));expect((await open(ask.id)).body).toEqual({status:'unavailable'});
   const sideEffects=await run('MATCH (n) WHERE n:Message OR n:DirectConversation OR (n:Conversation AND n.type="direct") RETURN count(n) AS count');expect(sideEffects.records[0].get('count').toNumber()).toBe(0);
  } finally {fetcher.mockRestore();}
 });
 it('confidential adapter authenticates exact identities and rejects foreign mutations and forged names',async()=>{
  const ask=await publish();
  expect((await post({operation:'list',owner:identity(a),viewer:null})).body.asks[0].id).toBe(ask.id);
  expect((await post({operation:'list',owner:identity('unknown-subject'),viewer:identity(b)})).body.asks).toEqual([]);
  expect((await post({operation:'close',owner:identity(a),viewer:identity(b),askId:ask.id,input:{expectedRevision:1}})).status).toBe(403);
  expect((await post({operation:'list',owner:{...identity(a),name:'Same Name'}})).status).toBe(400);
  expect((await request(app).post('/api/unlinked/profile-asks').send({operation:'list',owner:identity(a)})).status).toBe(401);
  expect((await post({operation:'list',owner:identity(a)}).set('Origin','https://www.unlinked.ai')).status).toBe(403);
  const audience=await session(s=>profileAskAudience(s,a));expect(audience.people.map(p=>p.id)).toEqual([b]);expect(audience.groups.map(p=>p.id)).toEqual([room]);
 });
});
