import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// OpenChat-3n0s: compose ranks people you actually talk to first, like every
// messenger, and finds them by name whatever their discovery setting.
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('compose contact ranking', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids = {
    me: `me-${s}`, claireRecent: `claire-recent-${s}`, claireOld: `claire-old-${s}`,
    claireStranger: `claire-stranger-${s}`, claireGroup: `claire-group-${s}`, claireHidden: `claire-hidden-${s}`,
  };
  const app = express(); app.use(express.json());
  const token = `Bearer ${jwt.sign({ userId: ids.me, email: `${ids.me}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  let driver: Driver;
  let db: typeof import('../src/db.js');

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    process.env.OPENCHAT_OPEN_USER_DIRECTORY = '1';
    db = await import('../src/db.js');
    app.use('/api/chat', (await import('../src/routes/chat.js')).default);
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $people AS p CREATE (:User {id: p.id, name: p.name, email: p.id + '@example.test', discoveryMode: p.mode})`,
        { people: [
          { id: ids.me, name: 'Me Myself', mode: 'name' },
          { id: ids.claireRecent, name: 'Claire Recent', mode: 'name' },
          { id: ids.claireOld, name: 'Claire Older', mode: 'name' },
          { id: ids.claireStranger, name: 'Aaa Claire Stranger', mode: 'name' },
          { id: ids.claireGroup, name: 'Claire Groupmate', mode: 'name' },
          { id: ids.claireHidden, name: 'Claire Hidden', mode: 'hidden' },
        ] },
      );
      const conv = `MATCH (a:User {id: $a}), (b:User {id: $b})
        CREATE (c:Conversation {id: $id, type: $type, createdAt: datetime($at), lastMessageAt: datetime($at)})
        CREATE (a)-[:PARTICIPATES_IN]->(c), (b)-[:PARTICIPATES_IN]->(c)`;
      await session.run(conv, { a: ids.me, b: ids.claireOld, id: `dm-old-${s}`, type: 'direct', at: '2026-01-01T00:00:00Z' });
      await session.run(conv, { a: ids.me, b: ids.claireRecent, id: `dm-new-${s}`, type: 'direct', at: '2026-10-01T00:00:00Z' });
      await session.run(conv, { a: ids.me, b: ids.claireHidden, id: `dm-hidden-${s}`, type: 'direct', at: '2026-05-01T00:00:00Z' });
      await session.run(conv, { a: ids.me, b: ids.claireGroup, id: `grp-${s}`, type: 'group', at: '2026-10-05T00:00:00Z' });
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run(`MATCH (c:Conversation) WHERE c.id ENDS WITH $s DETACH DELETE c`, { s });
      await session.run(`MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u`, { ids: Object.values(ids) });
    } finally {
      await session.close();
      await driver.close();
      await db.closeDatabase();
    }
  });

  const names = async (q: string) => {
    const res = await request(app).get(`/api/chat/contacts?q=${encodeURIComponent(q)}`).set('Authorization', token);
    expect(res.status).toBe(200);
    const mine = new Set(Object.values(ids));
    return (res.body as Array<{ id: string; name: string }>).filter((u) => mine.has(u.id)).map((u) => u.name);
  };

  it('searching a first name puts direct chats first, most recent first, then groupmates, then strangers', async () => {
    expect(await names('claire')).toEqual(['Claire Recent', 'Claire Hidden', 'Claire Older', 'Claire Groupmate', 'Aaa Claire Stranger']);
  });

  it('finds someone you already message even when they are hidden from discovery', async () => {
    expect(await names('claire hidden')).toEqual(['Claire Hidden']);
  });

  it('the default list leads with your recent conversations', async () => {
    const res = await request(app).get('/api/chat/contacts?limit=100').set('Authorization', token);
    const ordered = (res.body as Array<{ id: string }>).map((u) => u.id).filter((id) => Object.values(ids).includes(id));
    expect(ordered.slice(0, 4)).toEqual([ids.claireRecent, ids.claireHidden, ids.claireOld, ids.me]);
  });
});
