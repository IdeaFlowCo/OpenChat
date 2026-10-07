import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { writeFile } from 'node:fs/promises';
const state = vi.hoisted(() => ({ driver: null as any }));
vi.mock('../src/db.js', () => ({ getDriver: () => state.driver }));
import intentions from '../src/routes/contextIntentions.js';
import content from '../src/routes/conversationContent.js';
import webhooks from '../src/routes/contextWebhooks.js';
import { createContextPost } from '../src/services/contextLane.js';
import { askContextAgents } from '../src/services/contextAgentRequests.js';
import { ensureContextWebhookIndexes, runContextWebhookOnce } from '../src/services/contextWebhooks.js';

const prefix = 'evidence-' + crypto.randomUUID(), owner = prefix + '-owner', receiver = prefix + '-receiver', room = prefix + '-room', key = prefix + '-key';
let driver: Driver;
const session = async <T>(fn: (s: any) => Promise<T>) => { const s = driver.session(); try { return await fn(s); } finally { await s.close(); } };
const app = express(); app.use(express.json()); app.use('/api/chat', intentions, content); app.use('/api/chat/context-webhooks', webhooks);
const token = (userId: string) => jwt.sign({ userId, email: 'fixture@example.invalid' }, process.env.JWT_SECRET!);
const api = (user: string) => ({
  get: (path: string) => request(app).get('/api/chat' + path).set('Authorization', 'Bearer ' + token(user)),
  post: (path: string, body: any) => request(app).post('/api/chat' + path).set('Authorization', 'Bearer ' + token(user)).send(body),
  patch: (path: string, body: any) => request(app).patch('/api/chat' + path).set('Authorization', 'Bearer ' + token(user)).send(body),
});
beforeAll(async () => {
  if (!process.env.NEO4J_TEST_URI) return;
  driver = neo4j.driver(process.env.NEO4J_TEST_URI, neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD || 'test')); state.driver = driver;
  process.env.JWT_SECRET = 'isolated-evidence-session'; process.env.OPENCHAT_CONTEXT_LANE = 'true'; process.env.OPENCHAT_CONTEXT_WEBHOOKS_ENABLED = 'true'; process.env.OPENCHAT_CONTEXT_HOSTED_ENABLED = 'false';
  await ensureContextWebhookIndexes(driver);
  await session(s => s.run(`CREATE (a:User {id:$owner}),(b:User {id:$receiver}),(c:Conversation {id:$room,name:'Planning',type:'group'}),
    (:AgentKey {id:$key,ownerUserId:$receiver,scopes:['read','write'],contextRequestsEnabled:true}),
    (private:Thought {id:$prefix+'-private',userId:$owner,scopeConversationId:$room,text:'PRIVATE source note',createdAt:datetime()})
    CREATE (a)-[:PARTICIPATES_IN]->(c),(b)-[:PARTICIPATES_IN]->(c),(a)-[:HAS_THOUGHT]->(private)`, { owner, receiver, room, key, prefix }));
});
afterAll(async () => { if (!driver) return; await session(s => s.run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room OR n.ownerUserId IN [$owner,$receiver] DETACH DELETE n`, { prefix, room, owner, receiver })); await driver.close(); });
(process.env.NEO4J_TEST_URI ? it : it.skip)('demonstrates human API lifecycle, audience separation and signed synthetic wake with persisted receipts', async () => {
  const transcript: any = { isolation: 'fresh worktree-local Neo4j; synthetic identities and transport; no production access' };
  const post: any = await session(s => createContextPost(s, owner, room, { text: 'Find a planning partner', kind: 'ask', clientRequestId: prefix }));
  const path = `/conversations/${room}/context/${post.id}/intention`;
  const tracked = await api(owner).post(path, { sourceRevision: post.revision, clientRequestId: prefix + '-track' }); expect(tracked.status).toBe(200);
  const intention = tracked.body.intention; expect(intention.searchStatus).toBe('paused'); expect(intention.contextOnly).toBe(true);
  const again = await api(owner).post(path, { sourceRevision: post.revision, clientRequestId: prefix + '-track' }); expect(again.body.intention.intentId).toBe(intention.intentId);
  const closed = await api(owner).patch('/context-intentions/' + intention.intentId, { expectedRevision: intention.revision, lifecycleState: 'fulfilled' }); expect(closed.status).toBe(200); expect(closed.body.intention.contextPosts[0].post.status).toBe('closed');
  const reopened = await api(owner).patch('/context-intentions/' + intention.intentId, { expectedRevision: closed.body.intention.revision, lifecycleState: 'open' }); expect(reopened.status).toBe(200); expect(reopened.body.intention.searchStatus).toBe('paused'); expect(reopened.body.intention.intentId).toBe(intention.intentId);
  transcript.lifecycle = { tracked: tracked.body, retryIdentity: again.body.intention.intentId, fulfilled: closed.body, reopened: reopened.body };
  const mine = await api(owner).get(`/conversations/${room}/content`), theirs = await api(receiver).get(`/conversations/${room}/content`);
  expect(mine.status).toBe(200); expect(theirs.status).toBe(200); expect(mine.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(mine.body)).toContain('PRIVATE source note'); expect(JSON.stringify(theirs.body)).not.toContain('PRIVATE source note');
  transcript.reads = { owner: mine.body, participant: theirs.body, cacheControl: mine.headers['cache-control'] };
  const input = { conversationId: room, agentKeyId: key, url: 'https://receiver.example/context', clientRequestId: prefix + '-webhook', consent: false };
  const denied = await api(receiver).post('/context-webhooks', input); expect(denied.status).toBe(400);
  const approved = await api(receiver).post('/context-webhooks', { ...input, consent: true }); expect(approved.status).toBe(200);
  await session(s => askContextAgents(s, owner, room, post.id));
  const transport = vi.fn(async (_url: string, headers: Record<string,string>, body: string) => { transcript.wake = { headers, body: JSON.parse(body) }; return true; });
  expect(await runContextWebhookOnce(driver, transport)).toBe(true); expect(transport).toHaveBeenCalledTimes(1); expect(Object.keys(transcript.wake.body)).toEqual(['id','event','requestId']); expect(JSON.stringify(transcript.wake)).not.toContain('Find a planning partner'); expect(JSON.stringify(transcript.wake)).not.toContain(approved.body.secret);
  const receipts: any = await session(s => s.run('MATCH (d:ContextWebhookDelivery {conversationId:$room}) RETURN d.status AS status,d.attempts AS attempts,d.requestId AS requestId', { room }));
  transcript.webhook = { rejectedWithoutConsent: denied.body, subscription: approved.body.subscription, persistedReceipts: receipts.records.map((r: any) => ({status:r.get('status'),attempts:Number(r.get('attempts')),requestId:r.get('requestId')})) }; expect(transcript.webhook.persistedReceipts[0].status).toBe('delivered');
  if (process.env.CONTEXT_EVIDENCE_PATH) await writeFile(process.env.CONTEXT_EVIDENCE_PATH, JSON.stringify(transcript, null, 2) + '\n');
});
