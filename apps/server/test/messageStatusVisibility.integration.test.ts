import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, describe } from 'vitest';

const uri=process.env.NEO4J_TEST_URI,user=process.env.NEO4J_TEST_USER,password=process.env.NEO4J_TEST_PASSWORD;
const integration=uri&&user&&password?describe.sequential:describe.skip;
integration('message status visible to the chat reuses the Stream pin',()=>{
 const fixture=`message-status-vis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
 const id=(name:string)=>`${fixture}-${name}`;
 const app=express().use(express.json());let driver:Driver;let db:typeof import('../src/db.js');
 const events:Array<{rooms:unknown;event:string;payload:any}>=[];
 app.set('io',{to:(rooms:unknown)=>({emit:(event:string,payload:unknown)=>events.push({rooms,event,payload})})});
 const auth=(name:string)=>`Bearer ${jwt.sign({userId:id(name),email:`${name}@example.test`},process.env.JWT_SECRET||'dev-secret-change-me')}`;
 const path=(message:string)=>`/api/chat/message-status?messageId=${encodeURIComponent(message)}`;
 const list=(name:string)=>request(app).get(`/api/chat/message-status/conversation?conversationId=${encodeURIComponent(id('chat'))}`).set('Authorization',auth(name));
 const run=async(query:string,params:Record<string,unknown>={})=>{const session=driver.session();try{return await session.run(query,{fixture,...params});}finally{await session.close();}};
 beforeAll(async()=>{
  process.env.NEO4J_URI=uri!;process.env.NEO4J_USER=user!;process.env.NEO4J_PASSWORD=password!;
  db=await import('../src/db.js');driver=neo4j.driver(uri!,neo4j.auth.basic(user!,password!));
  app.use('/api/chat/message-status',(await import('../src/routes/messageStatus.js')).default);
  app.use('/api/thoughts',(await import('../src/routes/thoughts.js')).default);
  await run(`CREATE (a:User {id:$ana,name:'Ana Synthetic',fixture:$fixture}), (b:User {id:$ben,name:'Ben Synthetic',fixture:$fixture}), (:User {id:$outsider,fixture:$fixture})
   CREATE (c:Conversation {id:$chat,fixture:$fixture})
   CREATE (a)-[:PARTICIPATES_IN]->(c)<-[:PARTICIPATES_IN]-(b)
   CREATE (:Message {id:$m1,content:'Synthetic: can you send the deck?',conversationId:c.id,fixture:$fixture,createdAt:datetime()})
   CREATE (:Message {id:$m2,content:'Synthetic: lunch next week?',conversationId:c.id,fixture:$fixture,createdAt:datetime()})`,
   {ana:id('ana'),ben:id('ben'),outsider:id('outsider'),chat:id('chat'),m1:id('m1'),m2:id('m2')});
 });
 afterAll(async()=>{if(!driver)return;await run('MATCH (t:Thought) WHERE t.userId IN $owners DETACH DELETE t',{owners:[id('ana'),id('ben')]});await run('MATCH (n {fixture:$fixture}) DETACH DELETE n');await driver.close();await db.closeDatabase();});

 it('shares a status with the chat: the other participant sees the chip and the pinned Stream item',async()=>{
  const saved=await request(app).put(path(id('m1'))).set('Authorization',auth('ana')).send({status:'open',visibility:'chat'});
  expect(saved.status).toBe(200);expect(saved.body).toMatchObject({status:'open',visibility:'chat'});
  const ben=await list('ben');expect(ben.status).toBe(200);
  expect(ben.body.statuses).toEqual([expect.objectContaining({messageId:id('m1'),status:'open',userId:id('ana'),userName:'Ana Synthetic',visibility:'chat',own:false})]);
  const stream=await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization',auth('ben'));
  expect(stream.body.pinned.map((t:any)=>t.id)).toContain(saved.body.thoughtId);
  expect(events.some(e=>e.event==='message-status:changed'&&e.payload.status==='open')).toBe(true);
  expect((await request(app).get(path(id('m1'))).set('Authorization',auth('ana'))).body.visibility).toBe('chat');
 });
 it('never returns another participant’s private status, and the owner sees their own as only-you',async()=>{
  events.length=0;
  expect((await request(app).put(path(id('m2'))).set('Authorization',auth('ben')).send({status:'closed',visibility:'private'})).status).toBe(200);
  const ana=await list('ana');expect(ana.body.statuses.some((s:any)=>s.messageId===id('m2'))).toBe(false);
  const ben=await list('ben');expect(ben.body.statuses).toEqual(expect.arrayContaining([expect.objectContaining({messageId:id('m2'),status:'closed',own:true,visibility:'private'})]));
  expect(events.filter(e=>e.event==='message-status:changed')).toHaveLength(0);
  const stream=await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization',auth('ana'));
  expect(JSON.stringify(stream.body)).not.toContain('lunch next week');
 });
 it('moving a shared status to Only me withdraws it from the chat, pin included',async()=>{
  events.length=0;
  const saved=await request(app).put(path(id('m1'))).set('Authorization',auth('ana')).send({status:'closed',visibility:'private'});
  expect(saved.body).toMatchObject({status:'closed',visibility:'private'});
  expect((await list('ben')).body.statuses.some((s:any)=>s.messageId===id('m1'))).toBe(false);
  const pins=await run('MATCH (:Thought {id:$t})-[p:PINNED_IN]->() RETURN count(p) AS n',{t:saved.body.thoughtId});expect(pins.records[0]!.get('n').toNumber()).toBe(0);
  const withdrawn=events.find(e=>e.event==='message-status:changed')!;expect(withdrawn.payload).toMatchObject({status:'none',visibility:'private'});
 });
 it('clearing a shared status removes the chip and the pin; outsiders cannot list',async()=>{
  await request(app).put(path(id('m1'))).set('Authorization',auth('ana')).send({status:'open',visibility:'chat'});
  const cleared=await request(app).put(path(id('m1'))).set('Authorization',auth('ana')).send({status:'none'});
  expect(cleared.body.status).toBe('none');
  expect((await list('ben')).body.statuses.some((s:any)=>s.messageId===id('m1'))).toBe(false);
  expect((await list('outsider')).status).toBe(404);
 });
});
