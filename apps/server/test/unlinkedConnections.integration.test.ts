import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
const state = vi.hoisted(() => ({ driver: null as any }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));
import router from '../src/routes/unlinkedConnections.js';
import { ensureDirectConversation } from '../src/services/directConversation.js';
const issuer = 'https://id.ideaflow.app/api/auth', prefix = 'unlinked-sync-' + randomUUID(), secret = 'synthetic-secret-'.repeat(3);
const app = express().use(express.json()).use('/api', router);
let driver: Driver;
const query = async (q: string, params = {}) => { const s=driver.session(); try {return await s.run(q,params);} finally {await s.close();} };
const input = (suffix: string) => ({requestId:randomUUID(),acceptedAt:1000,sender:{issuer,subject:prefix+suffix+'-a',name:'Alice'},recipient:{issuer,subject:prefix+suffix+'-b',name:'Bob'}});
const post = (body: any) => request(app).post('/api/unlinked/connections/accepted').auth(secret,{type:'bearer'}).send(body);
const ids = async (body: any) => (await query('MATCH (u:User) WHERE u.ideaflowSub IN $subjects RETURN u.id AS id ORDER BY u.ideaflowSub',{subjects:[body.sender.subject,body.recipient.subject]})).records.map(r=>r.get('id'));
beforeAll(async()=>{
 if(!process.env.NEO4J_TEST_URI)return;
 driver=neo4j.driver(process.env.NEO4J_TEST_URI,neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j',process.env.NEO4J_TEST_PASSWORD!));state.driver=driver;vi.stubEnv('UNLINKED_MESSAGING_SECRET',secret);
 for(const q of ['CREATE CONSTRAINT acceptance_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE','CREATE CONSTRAINT acceptance_identity IF NOT EXISTS FOR (u:User) REQUIRE u.ideaflowIdentityKey IS UNIQUE','CREATE CONSTRAINT acceptance_dm IF NOT EXISTS FOR (c:Conversation) REQUIRE c.directPairKey IS UNIQUE','CREATE CONSTRAINT acceptance_receipt IF NOT EXISTS FOR (r:UnlinkedConnectionSync) REQUIRE r.requestId IS UNIQUE'])await query(q);
});
afterAll(async()=>{if(!driver)return;await query('MATCH (u:User) WHERE u.ideaflowSub STARTS WITH $prefix OPTIONAL MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation) DETACH DELETE c,u',{prefix});await driver.close();vi.unstubAllEnvs();});
const suite=process.env.NEO4J_TEST_URI?describe:describe.skip;
suite('accepted connection trusted HTTP + real graph',()=>{
 it('requires confidential authentication and rejects browser-selected identities',async()=>{
  const body=input('auth');expect((await request(app).post('/api/unlinked/connections/accepted').send(body)).status).toBe(401);
  expect((await request(app).post('/api/unlinked/connections/accepted').auth(secret,{type:'bearer'}).set('Origin','https://www.unlinked.ai').send(body)).status).toBe(403);
  expect((await post({...body,recipient:{...body.recipient,issuer:'https://other.invalid'}})).status).toBe(400);
  expect((await post({...body,recipient:body.sender})).status).toBe(400);expect(await ids(body)).toEqual([]);
 });
 it('concurrent retries create one empty DM and receipt; preserves independent privacy audiences',async()=>{
  const body=input('race');const replies=await Promise.all(Array.from({length:6},()=>post(body)));
  for(const r of replies){expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.body.status).toBe('synced');}
  expect(new Set(replies.map(r=>r.body.conversationId)).size).toBe(1);
  const members=await ids(body);expect(members).toHaveLength(2);
  const count=await query('MATCH (u:User)-[p:PARTICIPATES_IN]->(c:Conversation {id:$id}) RETURN count(p) AS n',{id:replies[0].body.conversationId});expect(Number(count.records[0].get('n'))).toBe(2);
  const effects=await query(`
   MATCH (m:Message)
   WHERE m.conversationId = $id
     OR EXISTS { MATCH (m)-[:IN_CONVERSATION]->(:Conversation {id: $id}) }
   RETURN count(m) AS n
  `,{id:replies[0].body.conversationId});expect(Number(effects.records[0].get('n'))).toBe(0);
  const friends=await query('MATCH (c:OpenChatConnection) WHERE c.firstId IN $ids OR c.secondId IN $ids RETURN count(c) AS n',{ids:members});expect(Number(friends.records[0].get('n'))).toBe(0);
  expect((await post({...body,recipient:{...body.recipient,subject:prefix+'different'}})).status).toBe(409);
  expect(await ids({...body,sender:{...body.sender,subject:prefix+'different'},recipient:{...body.recipient,subject:prefix+'different'}})).toEqual([]);
 });
 it('reuses an existing DM, including when a fresh accepted request has a different ID',async()=>{
  const body=input('reuse');const first=await post(body);const [a,b]=await ids(body);
  const ordinary=await ensureDirectConversation(a,b);expect(ordinary.created).toBe(false);expect(ordinary.conversation.id).toBe(first.body.conversationId);
  const second=await post({...body,requestId:randomUUID(),acceptedAt:2000});expect(second.body.conversationId).toBe(first.body.conversationId);
 });
 it('respects blocks and local declined/removed relations; retries after unblock cannot resurrect suppressed acceptance',async()=>{
  for(const restriction of ['block','declined','removed']){
   const body=input(restriction);
   await query('CREATE (a:User {id:$a,ideaflowIdentityKey:$ka,ideaflowIssuer:$issuer,ideaflowSub:$sa}),(b:User {id:$b,ideaflowIdentityKey:$kb,ideaflowIssuer:$issuer,ideaflowSub:$sb})',{a:body.sender.subject,b:body.recipient.subject,ka:issuer+'\u001f'+body.sender.subject,kb:issuer+'\u001f'+body.recipient.subject,issuer,sa:body.sender.subject,sb:body.recipient.subject});
   const [a,b]=await ids(body);
   if(restriction==='block')await query('MATCH (a:User {id:$a}),(b:User {id:$b}) CREATE (b)-[:BLOCKED]->(a)',{a,b});
   else await query('CREATE (:OpenChatConnection {pairKey:$pairKey,state:$state})',{pairKey:JSON.stringify([a,b].sort()),state:restriction});
   expect((await post(body)).body).toEqual({status:'suppressed',conversationId:null});
   await query('MATCH (a:User {id:$a})-[r:BLOCKED]-(b:User {id:$b}) DELETE r',{a,b});
   expect((await post(body)).body.status).toBe('suppressed');
   const count=await query('MATCH (:User {id:$a})-[:PARTICIPATES_IN]->(c) RETURN count(c) AS n',{a});expect(Number(count.records[0].get('n'))).toBe(0);
  }
 });
});
