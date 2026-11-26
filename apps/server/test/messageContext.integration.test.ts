import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;
integration('message permalinks against an isolated graph', () => {
  const fixture = `message-link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = (name: string) => `${fixture}-${name}`;
  const app = express(); let driver: Driver; let db: typeof import('../src/db.js');
  const auth = (name = 'viewer') => `Bearer ${jwt.sign({ userId: id(name), email: `${name}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  const run = async (query: string, params: Record<string, unknown> = {}) => {
    const session = driver.session(); try { return await session.run(query, { fixture, ...params }); } finally { await session.close(); }
  };
  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    db = await import('../src/db.js'); driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    app.use('/api/chat/messages', (await import('../src/routes/messageContext.js')).default);
    await run(`
      CREATE (viewer:User {id:$viewer,fixture:$fixture}), (other:User {id:$other,fixture:$fixture})
      CREATE (chat:Conversation {id:$chat,name:'Synthetic chat',fixture:$fixture})
      CREATE (viewer)-[:PARTICIPATES_IN]->(chat)
      WITH chat
      UNWIND range(0,70) AS n
      CREATE (:Message {id:$prefix + toString(n), conversationId:chat.id, fixture:$fixture,
        content:'Synthetic message ' + toString(n), createdAt:datetime('2020-01-01T00:00:00Z') + duration({seconds:n})})
    `, { viewer: id('viewer'), other: id('other'), chat: id('chat'), prefix: id('m') });
  });
  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n {fixture:$fixture}) DETACH DELETE n');
    await driver.close(); await db.closeDatabase();
  });
  it('resolves an old exact message with bounded neighbors without loading recent history first', async () => {
    const result = await request(app).get(`/api/chat/messages/${id('m10')}/context`).set('Authorization', auth());
    expect(result.status).toBe(200);
    expect(result.body.messageId).toBe(id('m10'));
    expect(result.body.messages).toHaveLength(11);
    expect(result.body.messages[0].id).toBe(id('m5'));
    expect(result.body.messages[10].id).toBe(id('m15'));
    expect(result.body.messages.find((m: {id:string}) => m.id === id('m10')).content).toBe('Synthetic message 10');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('returns the same unavailable result for absent, deleted and nonmember sources', async () => {
    const get = (message: string, viewer = 'viewer') => request(app).get(`/api/chat/messages/${id(message)}/context`).set('Authorization', auth(viewer));
    const absent = await get('missing'); const denied = await get('m10', 'other');
    await run('MATCH (m:Message {id:$id}) SET m.deletedAt=datetime()', { id: id('m11') });
    const deleted = await get('m11');
    for (const response of [absent, denied, deleted]) { expect(response.status).toBe(404); expect(response.body).toEqual({ error:'Message unavailable' }); }
  });
  it('removes access when conversation membership is revoked', async () => {
    await run('MATCH (:User {id:$viewer})-[p:PARTICIPATES_IN]->(:Conversation {id:$chat}) DELETE p', { viewer:id('viewer'),chat:id('chat') });
    const result = await request(app).get(`/api/chat/messages/${id('m10')}/context`).set('Authorization', auth());
    expect(result.status).toBe(404); expect(result.body).toEqual({ error:'Message unavailable' });
  });
});
