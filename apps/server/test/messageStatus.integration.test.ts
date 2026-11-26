import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uri=process.env.NEO4J_TEST_URI,user=process.env.NEO4J_TEST_USER,password=process.env.NEO4J_TEST_PASSWORD;
const integration=uri&&user&&password?describe.sequential:describe.skip;
integration('message status is one owner-private Stream capture',()=>{
 const fixture=`message-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
 const id=(name:string)=>`${fixture}-${name}`;
 const app=express().use(express.json());let driver:Driver;let db:typeof import('../src/db.js');
 const auth=(name='owner')=>`Bearer ${jwt.sign({userId:id(name),email:`${name}@example.test`},process.env.JWT_SECRET||'dev-secret-change-me')}`;
 const path=(message=id('source'))=>`/api/chat/message-status?messageId=${encodeURIComponent(message)}`;
 const run=async(query:string,params:Record<string,unknown>={})=>{const session=driver.session();try{return await session.run(query,{fixture,...params});}finally{await session.close();}};
 beforeAll(async()=>{
  process.env.NEO4J_URI=uri!;process.env.NEO4J_USER=user!;process.env.NEO4J_PASSWORD=password!;
  db=await import('../src/db.js');driver=neo4j.driver(uri!,neo4j.auth.basic(user!,password!));
  app.use('/api/chat/message-status',(await import('../src/routes/messageStatus.js')).default);
  app.use('/api/thoughts',(await import('../src/routes/thoughts.js')).default);
  await run(`CREATE (a:User {id:$owner,fixture:$fixture}), (b:User {id:$peer,fixture:$fixture}), (:User {id:$outsider,fixture:$fixture})
   CREATE (c:Conversation {id:$chat,fixture:$fixture})
   CREATE (a)-[:PARTICIPATES_IN]->(c)<-[:PARTICIPATES_IN]-(b)
   CREATE (:Message {id:$source,content:'Synthetic request',conversationId:c.id,fixture:$fixture,createdAt:datetime()})
   CREATE (:Message {id:$opaque,content:'Opaque identifier',conversationId:c.id,fixture:$fixture,createdAt:datetime()})`,{owner:id('owner'),peer:id('peer'),outsider:id('outsider'),chat:id('chat'),source:id('source'),opaque:id('a/b ?#研究')});
 });
 afterAll(async()=>{if(!driver)return;await run('MATCH (t:Thought) WHERE t.userId IN $owners DETACH DELETE t',{owners:[id('owner'),id('peer')]});await run('MATCH (n {fixture:$fixture}) DETACH DELETE n');await driver.close();await db.closeDatabase();});
 it('does not create a Stream entry when clearing a missing status',async()=>{
  const response=await request(app).put(path()).set('Authorization',auth()).send({status:'none'});
  expect(response.status).toBe(200);expect(response.body.thoughtId).toBeNull();
  const count=await run('MATCH (t:Thought {userId:$owner}) RETURN count(t) AS n',{owner:id('owner')});expect(count.records[0]!.get('n').toNumber()).toBe(0);
 });
 it('serializes concurrent repeated writes into one capture, then exposes the same status in the owner Stream',async()=>{
  const responses=await Promise.all(Array.from({length:5},()=>request(app).put(path()).set('Authorization',auth()).send({status:'open'})));
  expect(responses.every(r=>r.status===200)).toBe(true);expect(new Set(responses.map(r=>r.body.thoughtId)).size).toBe(1);
  const count=await run('MATCH (t:Thought {userId:$owner}) RETURN count(t) AS n',{owner:id('owner')});expect(count.records[0]!.get('n').toNumber()).toBe(1);
  const stream=await request(app).get('/api/thoughts').set('Authorization',auth());expect(stream.status).toBe(200);expect(stream.body).toHaveLength(1);expect(stream.body[0]).toMatchObject({id:responses[0]!.body.thoughtId,status:'open',captureMethod:'message-status'});
  expect((await request(app).put(path()).set('Authorization',auth()).send({status:'closed'})).body.thoughtId).toBe(responses[0]!.body.thoughtId);
  expect((await request(app).get(path()).set('Authorization',auth())).body.status).toBe('closed');
 });
 it('keeps participants’ statuses independent and never pins the capture into the shared chat',async()=>{
  const peer=await request(app).get(path()).set('Authorization',auth('peer'));expect(peer.body).toMatchObject({status:'none',thoughtId:null});
  const shared=await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization',auth('peer'));expect(shared.status).toBe(200);expect([...shared.body.pinned,...shared.body.fromChat]).toHaveLength(0);
  const response=await request(app).put(path()).set('Authorization',auth('peer')).send({status:'open'});expect(response.status).toBe(200);
  const owner=await request(app).get(path()).set('Authorization',auth());expect(owner.body.status).toBe('closed');expect(owner.body.thoughtId).not.toBe(response.body.thoughtId);
 });
 it('supports opaque IDs through query encoding without path normalization',async()=>{
  const response=await request(app).put(path(id('a/b ?#研究'))).set('Authorization',auth()).send({status:'open'});expect(response.status).toBe(200);expect(response.body.messageId).toBe(id('a/b ?#研究'));
 });
 it('refuses outsiders, deleted sources, and revoked membership without leaking captured status',async()=>{
  const outsider=await request(app).get(path()).set('Authorization',auth('outsider'));expect(outsider.status).toBe(404);
  expect((await request(app).put(path()).set('Authorization',auth('outsider')).send({status:'open'})).status).toBe(404);
  await run('MATCH (:User {id:$owner})-[p:PARTICIPATES_IN]->(:Conversation {id:$chat}) DELETE p',{owner:id('owner'),chat:id('chat')});
  expect((await request(app).get(path()).set('Authorization',auth())).status).toBe(404);
  await run('MATCH (m:Message {id:$source}) SET m.deletedAt=datetime()',{source:id('source')});
  expect((await request(app).put(path()).set('Authorization',auth('peer')).send({status:'closed'})).status).toBe(404);
 });
});
