import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// OpenChat-2pj3: searching "#event" missed reply-tag entries because tags are
// stored without '#' and the entry text is the parent message.
// OpenChat-q60e: collapse is the viewer's own preference on any readable entry.
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('Stream tag search and per-viewer collapse', () => {
  const fixture = `stream-collapse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = (name: string) => `${fixture}-${name}`;
  const app = express();
  app.use(express.json());
  let driver: Driver;
  let content: typeof import('../src/services/conversationContent.js');
  const auth = (name: string) => `Bearer ${jwt.sign({ userId: id(name), email: `${name}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  async function run(query: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(query, { fixture, ...params }); }
    finally { await session.close(); }
  }

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    app.use('/api/thoughts', (await import('../src/routes/thoughts.js')).default);
    content = await import('../src/services/conversationContent.js');
    await run(`
      CREATE (v:User {id: $viewer, fixture: $fixture}), (p:User {id: $peer, fixture: $fixture}), (o:User {id: $outsider, fixture: $fixture})
      CREATE (c:Conversation {id: $chat, type: 'direct', fixture: $fixture})
      CREATE (v)-[:PARTICIPATES_IN]->(c)<-[:PARTICIPATES_IN]-(p)
      CREATE (parent:Message {id: $parent, conversationId: c.id, senderId: p.id, fixture: $fixture,
        content: 'https://superconnector.network/chats?network=cambridge_combinator', createdAt: datetime('2026-09-30T21:27:00Z')})
      CREATE (parent)-[:IN_CONVERSATION]->(c)
      CREATE (v)-[:HAS_THOUGHT]->(t:Thought {id: $entry, fixture: $fixture, userId: v.id,
        text: parent.content, tags: ['event'], kind: 'observation', status: 'none',
        captureMethod: 'reply-tag', viaMessageId: $reply,
        createdAt: datetime('2026-09-30T21:35:00Z'), updatedAt: datetime('2026-09-30T21:35:00Z')})
      CREATE (t)-[:FROM_MESSAGE]->(parent)
      CREATE (p)-[:HAS_THOUGHT]->(:Thought {id: $peerPrivate, fixture: $fixture, userId: p.id,
        text: 'peer private', tags: [], kind: 'observation', status: 'none',
        createdAt: datetime('2026-09-30T21:36:00Z'), updatedAt: datetime('2026-09-30T21:36:00Z')})
    `, {
      viewer: id('viewer'), peer: id('peer'), outsider: id('outsider'), chat: id('chat'),
      parent: id('parent'), reply: id('reply'), entry: id('entry'), peerPrivate: id('peer-private'),
    });
  });

  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n {fixture: $fixture}) DETACH DELETE n');
    await driver.close();
    const db = await import('../src/db.js');
    await db.closeDatabase();
  });

  it('finds a reply-tag entry when the query includes the hashtag', async () => {
    for (const q of ['#event', 'event', '#EVENT', '#eve']) {
      const res = await request(app).get('/api/thoughts').query({ q }).set('Authorization', auth('viewer'));
      expect(res.status).toBe(200);
      expect(res.body.map((t: { id: string }) => t.id), q).toContain(id('entry'));
    }
    const miss = await request(app).get('/api/thoughts').query({ q: '#hiring' }).set('Authorization', auth('viewer'));
    expect(miss.body.map((t: { id: string }) => t.id)).not.toContain(id('entry'));
  });

  it('chat-scoped Stream and conversation content also match "#event"', async () => {
    const chat = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).query({ q: '#event' }).set('Authorization', auth('peer'));
    expect(chat.status).toBe(200);
    expect(chat.body.fromChat.map((t: { id: string }) => t.id)).toContain(id('entry'));
    const session = driver.session();
    try {
      const page = await content.listConversationContent(session, id('peer'), id('chat'), { filter: 'stream', search: '#event', contextAvailable: false });
      expect(page.items.map((item) => item.id)).toContain(id('entry'));
    } finally { await session.close(); }
  });

  it('collapse is saved per viewer and shown in every Stream read', async () => {
    const set = await request(app).put(`/api/thoughts/${id('entry')}/collapsed`).send({ collapsed: true }).set('Authorization', auth('peer'));
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ id: id('entry'), collapsed: true });

    // The peer sees it collapsed in the chat Stream and conversation content…
    const peerChat = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth('peer'));
    expect(peerChat.body.fromChat.find((t: { id: string }) => t.id === id('entry')).collapsed).toBe(true);
    const session = driver.session();
    try {
      const page = await content.listConversationContent(session, id('peer'), id('chat'), { filter: 'stream', contextAvailable: false });
      const item = page.items.find((i) => i.id === id('entry')) as { thought: { collapsed: boolean } };
      expect(item.thought.collapsed).toBe(true);
    } finally { await session.close(); }

    // …while the owner's view is unaffected.
    const owner = await request(app).get('/api/thoughts').set('Authorization', auth('viewer'));
    expect(owner.body.find((t: { id: string }) => t.id === id('entry')).collapsed).toBe(false);

    // Idempotent set, then expand.
    expect((await request(app).put(`/api/thoughts/${id('entry')}/collapsed`).send({ collapsed: true }).set('Authorization', auth('peer'))).status).toBe(200);
    const rels = await run('MATCH (:User {id: $peer})-[r:COLLAPSED_THOUGHT]->(:Thought {id: $entry}) RETURN count(r) AS n', { peer: id('peer'), entry: id('entry') });
    expect(rels.records[0].get('n').toNumber()).toBe(1);
    const unset = await request(app).put(`/api/thoughts/${id('entry')}/collapsed`).send({ collapsed: false }).set('Authorization', auth('peer'));
    expect(unset.body.collapsed).toBe(false);
    const after = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth('peer'));
    expect(after.body.fromChat.find((t: { id: string }) => t.id === id('entry')).collapsed).toBe(false);
  });

  it('shares collapse across legacy aliases selected by different searches', async () => {
    await run(`
      MATCH (t:Thought {id: $entry})-[:FROM_MESSAGE]->(m:Message), (v:User {id: $viewer})
      CREATE (v)-[:HAS_THOUGHT]->(a:Thought)
      SET a = properties(t), a.id = $alias, a.tags = ['alias-only']
      CREATE (a)-[:FROM_MESSAGE]->(m)
    `, { entry: id('entry'), viewer: id('viewer'), alias: id('alias') });
    await run(`
      MATCH (v:User {id: $viewer}), (a:Thought {id: $alias})
      CREATE (v)-[:COLLAPSED_THOUGHT]->(a)
    `, { viewer: id('viewer'), alias: id('alias') });
    for (const q of ['', '#event', '#alias-only']) {
      const res = await request(app).get('/api/thoughts').query({ q }).set('Authorization', auth('viewer'));
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((t: { collapsed: boolean }) => t.collapsed)).toBe(true);
    }
    for (const collapsed of [true, false]) {
      const res = await request(app).put(`/api/thoughts/${id('alias')}/collapsed`).send({ collapsed }).set('Authorization', auth('viewer'));
      expect(res.status).toBe(200);
      const rels = await run(`
        MATCH (:User {id: $viewer})-[r:COLLAPSED_THOUGHT]->(t:Thought)
        WHERE t.id IN [$entry, $alias] RETURN count(r) AS n
      `, { viewer: id('viewer'), entry: id('entry'), alias: id('alias') });
      expect(rels.records[0].get('n').toNumber()).toBe(collapsed ? 2 : 0);
      const chat = await request(app).get(`/api/thoughts/conversation/${id('chat')}`).set('Authorization', auth('viewer'));
      expect(chat.body.fromChat.every((t: { collapsed: boolean }) => t.collapsed === collapsed)).toBe(true);
      const session = driver.session();
      try {
        const page = await content.listConversationContent(session, id('viewer'), id('chat'), { filter: 'stream', contextAvailable: false });
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.every(item => item.origin === 'stream' && item.thought.collapsed === collapsed)).toBe(true);
      } finally { await session.close(); }
    }
  });

  it('cannot collapse entries the viewer cannot read', async () => {
    const outsider = await request(app).put(`/api/thoughts/${id('entry')}/collapsed`).send({ collapsed: true }).set('Authorization', auth('outsider'));
    expect(outsider.status).toBe(404);
    const othersPrivate = await request(app).put(`/api/thoughts/${id('peer-private')}/collapsed`).send({ collapsed: true }).set('Authorization', auth('viewer'));
    expect(othersPrivate.status).toBe(404);
    const invalid = await request(app).put(`/api/thoughts/${id('entry')}/collapsed`).send({ collapsed: 'yes' }).set('Authorization', auth('viewer'));
    expect(invalid.status).toBe(400);
    const rels = await run('MATCH (u:User)-[r:COLLAPSED_THOUGHT]->(t:Thought) WHERE t.fixture = $fixture RETURN count(r) AS n');
    expect(rels.records[0].get('n').toNumber()).toBe(0);
  });
});
