import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
const state = vi.hoisted(() => ({ driver: null as any }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));
import router from '../src/routes/unlinkedConnections.js';
import chatRouter from '../src/routes/chat.js';
import { ensureDirectConversation } from '../src/services/directConversation.js';
const issuer = 'https://id.ideaflow.app/api/auth', prefix = 'unlinked-sync-' + randomUUID(), secret = 'synthetic-secret-'.repeat(3);
const app = express().use(express.json()).use('/api', router).use('/api/chat', chatRouter);
const requestIds = new Set<string>();
let driver: Driver;
const query = async (q: string, params = {}) => { const s=driver.session(); try {return await s.run(q,params);} finally {await s.close();} };
const input = (suffix: string) => ({requestId:randomUUID(),acceptedAt:1000,sender:{issuer,subject:prefix+suffix+'-a',name:'Alice'},recipient:{issuer,subject:prefix+suffix+'-b',name:'Bob'}});
const post = (body: any) => { requestIds.add(body.requestId); return request(app).post('/api/unlinked/connections/accepted').auth(secret,{type:'bearer'}).send(body); };
const ids = async (body: any) => (await query('MATCH (u:User) WHERE u.ideaflowSub IN $subjects RETURN u.id AS id ORDER BY u.ideaflowSub',{subjects:[body.sender.subject,body.recipient.subject]})).records.map(r=>r.get('id'));
beforeAll(async()=>{
 if(!process.env.NEO4J_TEST_URI)return;
 driver=neo4j.driver(process.env.NEO4J_TEST_URI,neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j',process.env.NEO4J_TEST_PASSWORD!));state.driver=driver;vi.stubEnv('UNLINKED_MESSAGING_SECRET',secret);
 // Match production's additive schema: legacy shared User IDs are not globally unique.
 // Other integration suites can leave duplicate synthetic assistant IDs.
 for(const q of ['CREATE CONSTRAINT acceptance_identity IF NOT EXISTS FOR (u:User) REQUIRE u.ideaflowIdentityKey IS UNIQUE','CREATE CONSTRAINT acceptance_dm IF NOT EXISTS FOR (c:Conversation) REQUIRE c.directPairKey IS UNIQUE','CREATE CONSTRAINT acceptance_receipt IF NOT EXISTS FOR (r:UnlinkedConnectionSync) REQUIRE r.requestId IS UNIQUE'])await query(q);
});
afterAll(async()=>{if(!driver)return;await query('MATCH (r:UnlinkedConnectionSync) WHERE r.requestId IN $ids DETACH DELETE r',{ids:[...requestIds]});await query('MATCH (r:OpenChatConnection) WHERE r.pairKey CONTAINS $prefix DETACH DELETE r',{prefix});await query('MATCH (u:User) WHERE u.ideaflowSub STARTS WITH $prefix OPTIONAL MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation) DETACH DELETE c,u',{prefix});await driver.close();vi.unstubAllEnvs();});
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
 it('exposes the retried acceptance as one private empty chat to both authenticated members', async () => {
  const body = input('http-journey');
  vi.stubEnv('JWT_SECRET', secret);
  await query('CREATE INDEX IF NOT EXISTS FOR (m:Message) ON (m.conversationId)');
  await query('CALL db.awaitIndexes()');
  // Ignore the first acknowledgement, as a sender would after losing a response.
  const first = await post(body);
  expect(first.status).toBe(200);
  const retry = await post(body);
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(first.body);
  const members = await ids(body);
  expect(members).toHaveLength(2);
  const responses: unknown[] = [];
  const get = (path: string, userId: string) => request(app).get(`/api/chat${path}`)
   .auth(jwt.sign({ userId, email: 'fictional@example.test' }, secret), { type: 'bearer' });
  for (const userId of members) {
   const list = await get('/conversations', userId);
   expect(list.status).toBe(200);
   expect(list.body).toHaveLength(1);
   expect(list.body[0]).toMatchObject({ id: retry.body.conversationId, type: 'direct', lastMessage: null, unreadCount: 0 });
   expect(list.body[0].participants.map((p: any) => p.user.id).sort()).toEqual([...members].sort());
   const detail = await get(`/conversations/${retry.body.conversationId}`, userId);
   expect(detail.status).toBe(200);
   const messages = await get(`/conversations/${retry.body.conversationId}/messages`, userId);
   expect(messages.status).toBe(200);
   expect(messages.body.messages).toEqual([]);
   const unread = await get('/unread-total', userId);
   expect(unread.status).toBe(200);
   expect(unread.body).toEqual({ unreadTotal: 0 });
   responses.push({ userId, conversations: list.body, detail: detail.body, messages: messages.body, unread: unread.body });
  }
  const outsider = await get(`/conversations/${retry.body.conversationId}`, prefix + '-outsider');
  expect(outsider.status).toBe(404);
  const identities = (await query('MATCH (u:User) WHERE u.id IN $ids RETURN u.ideaflowIssuer AS issuer,u.ideaflowSub AS subject,u.ideaflowIdentityKey AS key ORDER BY subject', { ids: members })).records.map(r => r.toObject());
  expect(identities).toEqual([body.sender, body.recipient].map(m => ({ issuer: m.issuer, subject: m.subject, key: m.issuer + '\u001f' + m.subject })));
  const receipts = await query('MATCH (r:UnlinkedConnectionSync {requestId:$id}) RETURN count(r) AS count', { id: body.requestId });
  expect(Number(receipts.records[0].get('count'))).toBe(1);
  const friendships = await query('MATCH (c:OpenChatConnection) WHERE c.pairKey=$pair RETURN count(c) AS count', { pair: JSON.stringify([...members].sort()) });
  expect(Number(friendships.records[0].get('count'))).toBe(0);
  if (process.env.UNLINKED_ACCEPTANCE_EVIDENCE_PATH) writeFileSync(process.env.UNLINKED_ACCEPTANCE_EVIDENCE_PATH,
   JSON.stringify({ scenario: 'Receiver HTTP acceptance, ignored first acknowledgement, retry, then both authenticated chat journeys', acceptance: first.body, retry: retry.body, identities, receiptCount: 1, friendshipCount: 0, responses, outsider: { status: outsider.status, body: outsider.body } }, null, 2) + '\n');
 });
 it('keeps a known receipt outside generic Node/File selection and sharing projections', async () => {
  const body = input('ledger-boundary');
  const response = await post(body);
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('synced');
  const result = await query(`
   MATCH (r:UnlinkedConnectionSync {requestId: $requestId})
   OPTIONAL MATCH (r)-[link]-()
   RETURN elementId(r) AS elementId, labels(r) AS labels,
          properties(r) AS properties, count(link) AS links
  `, { requestId: body.requestId });
  expect(result.records).toHaveLength(1);
  const record = result.records[0];
  expect(record.get('labels')).toEqual(['UnlinkedConnectionSync']);
  expect(Number(record.get('links'))).toBe(0);
  // This operational receipt has no raw identity, content, visibility,
  // ownership or sharing properties that a generic projection could export.
  const properties = record.get('properties');
  expect(Object.keys(properties).sort()).toEqual([
   'binding', 'completedAt', 'conversationId', 'createdAt', 'lockVersion', 'requestId', 'status',
  ]);
  expect(properties).toMatchObject({ requestId: body.requestId, status: 'synced', conversationId: response.body.conversationId });
  expect(properties.binding).toMatch(/^[a-f0-9]{64}$/);
  // Check the same known element, rather than succeeding because an ID lookup
  // missed it. These are the label selectors in the audited Noos routes;
  // this does not claim to exercise the Noos HTTP handlers or operator access.
  const selections: Record<string, number> = {};
  for (const label of ['Node', 'File']) {
   const selected = await query(`MATCH (r:${label}) WHERE elementId(r) = $elementId RETURN r`, {
    elementId: record.get('elementId'),
   });
   expect(selected.records).toEqual([]);
   selections[label] = selected.records.length;
  }
  if (process.env.UNLINKED_RECEIPT_EVIDENCE_PATH) writeFileSync(process.env.UNLINKED_RECEIPT_EVIDENCE_PATH,
   JSON.stringify({ scenario: 'Authenticated synthetic acceptance receipt graph boundary', acceptance: response.body,
    elementId: record.get('elementId'), labels: record.get('labels'), properties,
    links: Number(record.get('links')), selections }, null, 2) + '\n');
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
