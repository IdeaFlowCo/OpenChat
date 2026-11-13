import { afterAll,beforeAll,describe,it,expect,vi } from 'vitest';
import neo4j from 'neo4j-driver';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
const state=vi.hoisted(()=>({driver:null as any}));
vi.mock('../src/db.js',()=>({getDriver:()=>state.driver}));
import router from '../src/routes/unlinkedGroups.js';
import chatRouter from '../src/routes/chat.js';
const issuer='https://id.ideaflow.app/api/auth', prefix='community-'+randomUUID(),secret='synthetic-only-'.repeat(4),groups:string[]=[];
const app=express().use(express.json()).use('/api',router).use('/api/chat',chatRouter);
const q=async(query:string,params={})=>{const s=state.driver.session();try{return await s.run(query,params)}finally{await s.close()}};
const member=(name:string)=>({issuer,subject:prefix+name,name});
const snapshot=()=>{const groupId=randomUUID();groups.push(groupId);return {groupId,revision:1,name:'Builders',organizer:member('organizer'),members:[member('member')],deleted:false}};
const post=(body:any)=>request(app).post('/api/unlinked/groups/sync').auth(secret,{type:'bearer'}).send(body);
const userId=async(subject:string)=>(await q('MATCH(u:User {ideaflowSub:$subject}) RETURN u.id AS id',{subject})).records[0].get('id');
const token=(id:string)=>jwt.sign({userId:id,email:"fixture@example.test"},secret);
const suite=process.env.NEO4J_TEST_URI?describe:describe.skip;
suite('managed community chat actual HTTP and Neo4j',()=>{
 beforeAll(async()=>{state.driver=neo4j.driver(process.env.NEO4J_TEST_URI!,neo4j.auth.basic(process.env.NEO4J_TEST_USER??'neo4j',process.env.NEO4J_TEST_PASSWORD!));vi.stubEnv('UNLINKED_MESSAGING_SECRET',secret);vi.stubEnv('JWT_SECRET',secret);
  for(const query of ['CREATE CONSTRAINT community_identity IF NOT EXISTS FOR(u:User) REQUIRE u.ideaflowIdentityKey IS UNIQUE','CREATE CONSTRAINT community_sync IF NOT EXISTS FOR(s:UnlinkedGroupSync) REQUIRE s.groupId IS UNIQUE','CREATE CONSTRAINT community_conversation IF NOT EXISTS FOR(c:Conversation) REQUIRE c.id IS UNIQUE','CREATE INDEX IF NOT EXISTS FOR(m:Message) ON(m.conversationId)'])await q(query);
  await q('CALL db.awaitIndexes()');
 });
 afterAll(async()=>{await q('MATCH(c:Conversation) WHERE c.unlinkedGroupId IN $groups OPTIONAL MATCH(c)-[:HAS_INVITE]->(i:GroupInvite) DETACH DELETE c,i',{groups});await q('MATCH(s:UnlinkedGroupSync) WHERE s.groupId IN $groups DELETE s',{groups});await q('MATCH(u:User) WHERE u.ideaflowSub STARTS WITH $prefix DETACH DELETE u',{prefix});await state.driver.close();vi.unstubAllEnvs()});
 it('rejects anonymous and browser roster injection',async()=>{
  const body=snapshot();expect((await request(app).post('/api/unlinked/groups/sync').send(body)).status).toBe(401);
  expect((await request(app).post('/api/unlinked/groups/sync').auth(secret,{type:'bearer'}).set('Origin','https://www.unlinked.ai').send(body)).status).toBe(403);
  expect((await post({...body,members:[body.organizer]})).status).toBe(400);
 });
 it('retry/concurrency converges, each member sees normal inbox, removal revokes access and stale snapshots cannot restore',async()=>{
  const body=snapshot(),results=await Promise.all([post(body),post(body),post(body)]);
  for(const r of results)expect(r.status,r.text).toBe(200);
  expect(new Set(results.map(r=>r.body.conversationId)).size).toBe(1);
  const id=results[0].body.conversationId,owner=await userId(body.organizer.subject),person=await userId(body.members[0].subject);
  for(const u of [owner,person]){
   const r=await request(app).get('/api/chat/conversations').auth(token(u),{type:'bearer'});expect(r.status).toBe(200);expect(r.body.some((c:any)=>c.id===id)).toBe(true);
  }
  expect((await request(app).post(`/api/chat/conversations/${id}/invites`).auth(token(owner),{type:'bearer'}).send({})).status).toBe(409);
  expect((await request(app).delete(`/api/chat/conversations/${id}/participants/${person}`).auth(token(person),{type:'bearer'})).status).toBe(409);
  const newer={...body,revision:2,members:[]};expect((await post(newer)).status).toBe(200);
  expect((await request(app).get(`/api/chat/conversations/${id}`).auth(token(person),{type:'bearer'})).status).toBe(404);
  expect((await post(body)).status).toBe(409);expect((await post({...newer,members:body.members})).status).toBe(409);
  expect((await post({...newer,revision:3,deleted:true})).status).toBe(200);
  expect((await request(app).get(`/api/chat/conversations/${id}`).auth(token(owner),{type:'bearer'})).status).toBe(404);
  expect((await post({...body,revision:4})).status).toBe(409);
 });
 it('migrates an owned existing group without losing messages, and refuses someone else’s group',async()=>{
  const body=snapshot();await post(body);const owner=await userId(body.organizer.subject);
  const existing=await request(app).post('/api/chat/conversations').auth(token(owner),{type:'bearer'}).send({type:'group',title:'Existing',participantIds:[]});expect(existing.status,existing.text).toBe(201);
  const id=existing.body.id;
  const message=await request(app).post(`/api/chat/conversations/${id}/messages`).auth(token(owner),{type:'bearer'}).send({content:'Synthetic preserved history',type:'text'});expect(message.status,message.text).toBe(201);
  const invite=await request(app).post(`/api/chat/conversations/${id}/invites`).auth(token(owner),{type:'bearer'}).send({});expect(invite.status).toBe(201);
  const another=snapshot();expect((await post({...another,existingConversationId:id})).status).toBe(200);
  const history=await request(app).get(`/api/chat/conversations/${id}/messages`).auth(token(owner),{type:'bearer'});expect(history.text).toContain('Synthetic preserved history');
  const outsider=await userId(member('member').subject);
  expect((await request(app).post(`/api/chat/invites/${invite.body.token}/accept`).auth(token(outsider),{type:'bearer'}).send({})).status).toBe(410);
  const hijack=snapshot();expect((await post({...hijack,organizer:member('imposter'),members:[],existingConversationId:id})).status).toBe(409);
 });
});
