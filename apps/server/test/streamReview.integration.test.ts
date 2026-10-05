import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('Stream routes against graph fixtures', () => {
  const fixture = `stream-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = (name: string) => `${fixture}-${name}`;
  const app = express();
  app.use(express.json());
  let driver: Driver;
  let db: typeof import('../src/db.js');
  const auth = (name = 'viewer') => `Bearer ${jwt.sign({ userId: id(name), email: `${name}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  async function run(query: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(query, { fixture, ...params }); }
    finally { await session.close(); }
  }
  async function capture(name: string, owner: string, tags: string[], method: string, chat = 'chat', source = 'source') {
    await run(`
      MATCH (u:User {id: $owner}), (m:Message {id: $source})
      CREATE (u)-[:HAS_THOUGHT]->(t:Thought {
        id: $id, fixture: $fixture, userId: $owner, text: $text,
        tags: $tags, captureMethod: $method, kind: 'observation', status: 'none',
        createdAt: datetime('2026-09-20T10:00:00Z')
      })-[:FROM_MESSAGE]->(m)
    `, { owner: id(owner), source: id(chat === 'chat' ? source : 'hidden-source'), id: id(name), tags, method, text: `${name} Launch Friday` });
  }
  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    db = await import('../src/db.js');
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    app.use('/api/thoughts', (await import('../src/routes/thoughts.js')).default);
    await run(`UNWIND $ids AS id CREATE (:User {id: id, fixture: $fixture})`, { ids: ['viewer', 'peer', 'outsider'].map(id) });
    await run(`
      MATCH (v:User {id: $viewer}), (p:User {id: $peer}), (o:User {id: $outsider})
      CREATE (c:Conversation {id: $chat, fixture: $fixture})
      CREATE (h:Conversation {id: $hidden, fixture: $fixture})
      CREATE (v)-[:PARTICIPATES_IN]->(c)<-[:PARTICIPATES_IN]-(p)
      CREATE (o)-[:PARTICIPATES_IN]->(h)
      CREATE (:Message {id: $source, conversationId: c.id, content: 'Launch Friday', fixture: $fixture, createdAt: datetime('2026-09-20T10:00:00Z')})
      CREATE (:Message {id: $hiddenSource, conversationId: h.id, content: 'Hidden', fixture: $fixture, createdAt: datetime('2026-09-20T10:00:00Z')})
    `, { viewer: id('viewer'), peer: id('peer'), outsider: id('outsider'), chat: id('chat'), hidden: id('hidden'), source: id('source'), hiddenSource: id('hidden-source') });
    await capture('own', 'viewer', ['decision', 'équipe', 'q4-goals', 'two_words'], 'manual');
    await capture('shared', 'peer', ['decision', 'design'], 'inline-tag');
    await capture('reply', 'peer', ['hiring'], 'reply-tag');
    await capture('private', 'peer', ['denied-private'], 'manual');
    await capture('inaccessible', 'outsider', ['denied-hidden'], 'inline-tag', 'hidden');
    await run(`MATCH (u:User {id: $viewer}) CREATE (u)-[:HAS_THOUGHT]->(:Thought {
      id: $scoped, fixture: $fixture, userId: u.id, text: 'Scoped draft', scopeConversationId: $chat,
      tags: [], createdAt: datetime('2026-09-20T10:00:01Z')
    })`, { viewer: id('viewer'), scoped: id('scoped'), chat: id('chat') });
  });
  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n {fixture: $fixture}) DETACH DELETE n');
    await driver.close();
    await db.closeDatabase();
  });
  it('returns peer hashtag captures and owner scoped entries without private peer captures', async () => {
    const res = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.pinned).toEqual([]);
    expect(res.body.fromChat.map((t: { id: string }) => t.id).sort()).toEqual(['own', 'shared', 'reply', 'scoped'].map(id).sort());
    const search = await request(app).get(`/api/thoughts/conversation/${id('chat')}?q=hiring`).set('Authorization', auth());
    expect(search.status).toBe(200);
    expect(search.body.fromChat.map((t: { id: string }) => t.id)).toEqual([id('reply')]);
    expect((await request(app).get(`/api/thoughts/conversation/${id('hidden')}`).set('Authorization', auth())).status).toBe(404);
  });
  it('ranks accessible tags and excludes private and inaccessible captures for global and chat suggestions', async () => {
    for (const query of [{ q: 'de' }, { q: 'de', conversationId: id('chat') }]) {
      const res = await request(app).get('/api/thoughts/tags/suggestions').query(query).set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.map((s: { tag: string }) => s.tag)).toEqual(['decision', 'design']);
      expect(res.body[0]).toMatchObject({ source: 'both', ownCount: 1, chatCount: 1 });
      expect(res.body[1]).toMatchObject({ source: 'chat', ownCount: 0, chatCount: 1 });
    }
    expect((await request(app).get('/api/thoughts/tags/suggestions').query({ conversationId: id('hidden') }).set('Authorization', auth())).status).toBe(404);
    for (const [q, tag] of [['é', 'équipe'], ['q4-', 'q4-goals'], ['two_', 'two_words']]) {
      const res = await request(app).get('/api/thoughts/tags/suggestions').query({ q }).set('Authorization', auth());
      expect(res.status).toBe(200);
      expect(res.body.map((s: { tag: string }) => s.tag)).toEqual([tag]);
    }
  });
  it('preserves reply tags when editing parent text and derives ordinary tags from edited text', async () => {
    const reply = await request(app).patch(`/api/thoughts/${id('reply')}`).set('Authorization', auth('peer')).send({ text: 'Launch Monday' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ id: id('reply'), text: 'Launch Monday', tags: ['hiring'] });
    const stored = await run('MATCH (t:Thought {id: $id}) RETURN t.tags AS tags', { id: id('reply') });
    expect(stored.records[0].get('tags')).toEqual(['hiring']);
    const own = await request(app).patch(`/api/thoughts/${id('own')}`).set('Authorization', auth()).send({ text: 'Updated #équipe' });
    expect(own.status).toBe(200);
    expect(own.body.tags).toEqual(['équipe']);
  });
  it('creates private unpinned scoped entries and shares them with peers only after pinning', async () => {
    const created = await request(app).post('/api/thoughts').set('Authorization', auth()).send({
      text: 'Private scoped entry', scopeConversationId: id('chat'),
    });
    expect(created.status).toBe(201);
    const thoughtId = created.body.id;
    expect(typeof thoughtId).toBe('string');
    await run('MATCH (t:Thought {id: $id}) SET t.fixture = $fixture', { id: thoughtId });
    expect(created.body).toMatchObject({ scopeConversationId: id('chat'), pinned: false });
    const owner = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth());
    expect(owner.status).toBe(200);
    expect(owner.body.fromChat.map((t: { id: string }) => t.id)).toContain(thoughtId);
    const peer = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth('peer'));
    expect(peer.status).toBe(200);
    expect([...peer.body.fromChat, ...peer.body.pinned].map((t: { id: string }) => t.id)).not.toContain(thoughtId);
    const pinned = await request(app).post(`/api/thoughts/${thoughtId}/pin`).set('Authorization', auth()).send({ conversationId: id('chat') });
    expect(pinned.status).toBe(200);
    const shared = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth('peer'));
    expect(shared.status).toBe(200);
    expect(shared.body.pinned.map((t: { id: string }) => t.id)).toContain(thoughtId);
  });
  it('returns five neighbors on each side including equal timestamps ordered by ID', async () => {
    const messageIds = Array.from({ length: 15 }, (_, i) => id(`ordered-${String(i).padStart(2, '0')}`));
    await run(`UNWIND $ids AS id CREATE (:Message {id: id, fixture: $fixture, conversationId: $chat, content: id, createdAt: datetime('2026-09-21T10:00:00Z')})`, { ids: messageIds, chat: id('chat') });
    await capture('ordered-capture', 'viewer', [], 'manual', 'chat', 'ordered-07');
    const res = await request(app).get(`/api/thoughts/${id('ordered-capture')}/context`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe(messageIds[7]);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(messageIds.slice(2, 13));
    await run('MATCH (m:Message {id: $id}) SET m.deletedAt = datetime()', { id: messageIds[7] });
    const deleted = await request(app).get(`/api/thoughts/${id('ordered-capture')}/context`).set('Authorization', auth());
    expect(deleted.status).toBe(404);
    expect(deleted.body).toEqual({ error: 'Original message unavailable' });
  });
});
