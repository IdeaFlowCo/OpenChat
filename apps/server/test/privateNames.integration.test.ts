import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('private names real Neo4j + HTTP privacy', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids = ['alice', 'bob', 'mallory', 'hidden', 'bot', 'deleted', 'no-dm', 'email-only', 'other-email'].map(id => `private-name-${id}-${suffix}`);
  const [alice, bob, mallory, hidden, bot, deleted, noDm, emailOnly, otherEmail] = ids;
  const conversationId = `private-name-chat-${suffix}`;
  let driver: Driver;
  let db: typeof import('../src/db.js');
  const app = express(); app.use(express.json());
  const token = (id: string) => `Bearer ${jwt.sign({ userId: id, email: `${id}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  const path = (id: string) => `/api/private-names/${id}`;
  async function run(query: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(query, params); } finally { await session.close(); }
  }
  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    db = await import('../src/db.js');
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    app.use('/api/private-names', (await import('../src/routes/privateNames.js')).default);
    app.use('/api/card', (await import('../src/routes/addMeCard.js')).default);
    app.use('/api/chat', (await import('../src/routes/chat.js')).default);
    await run(`UNWIND $ids AS id CREATE (:User {id: id, name: 'Official Name', discoveryMode: 'name'})`, { ids });
    await run(`MATCH (u:User {id: $hidden}) SET u.discoveryMode = 'hidden'`, { hidden });
    await run(`MATCH (u:User {id: $bot}) SET u.isBot = true`, { bot });
    await run(`MATCH (a:User {id: $alice}), (b:User {id: $bob}) CREATE (c:Conversation {id: $conversationId, type: 'direct'}) CREATE (a)-[:PARTICIPATES_IN {role: 'owner'}]->(c)<-[:PARTICIPATES_IN {role: 'member'}]-(b)`, { alice, bob, conversationId });
  });
  afterAll(async () => {
    if (!driver) return;
    await run(`MATCH (c:Conversation {id: $conversationId}) DETACH DELETE c`, { conversationId });
    await run(`MATCH (u:User) WHERE u.id IN $ids OPTIONAL MATCH (u)-[:HAS_ADDME_CARD]->(c:AddMeCard) DETACH DELETE c, u`, { ids });
    await driver.close(); await db.closeDatabase();
  });
  it('reads official identity and sets/clears a private name with zero conversations', async () => {
    await run(`MATCH (u:User {id: $noDm}) SET u.email = 'private@example.test', u.phone = 'private-phone'`, { noDm });
    const profile = await request(app).get(`${path(noDm)}/profile`).set('Authorization', token(alice));
    expect(profile.status).toBe(200);
    expect(profile.body).toEqual({ id: noDm, name: 'Official Name', avatarUrl: null, isBot: false });
    expect(profile.headers['cache-control']).toBe('no-store');
    expect((await request(app).put(path(noDm)).set('Authorization', token(alice)).send({ name: 'Person without DM' })).status).toBe(200);
    expect((await request(app).get(path(noDm)).set('Authorization', token(alice))).body.name).toBe('Person without DM');
    expect((await request(app).get(`${path(noDm)}/profile`).set('Authorization', token(mallory))).body).toEqual(profile.body);
    expect((await request(app).get(path(noDm)).set('Authorization', token(mallory))).body.name).toBeNull();
    expect((await request(app).delete(path(noDm)).set('Authorization', token(alice))).body.name).toBeNull();
    const count = await run(`MATCH (:User {id: $noDm})-[:PARTICIPATES_IN]->(c) RETURN count(c) AS count`, { noDm });
    expect(count.records[0].get('count').toNumber()).toBe(0);
    for (const id of [hidden, 'missing-person']) {
      expect((await request(app).get(`${path(id)}/profile`).set('Authorization', token(alice))).status).toBe(404);
    }
    await run(`MATCH (a:User {id: $alice}), (b:User {id: $noDm}) CREATE (b)-[:BLOCKED]->(a)`, { alice, noDm });
    expect((await request(app).get(`${path(noDm)}/profile`).set('Authorization', token(alice))).status).toBe(404);
  });
  it('rechecks exact-email discovery for every profile and alias operation without granting ID access', async () => {
    const email = `exact-${suffix}@example.test`;
    await run(`MATCH (u:User) WHERE u.id IN $targets SET u.discoveryMode = 'email_only', u.email = CASE WHEN u.id = $target THEN $email ELSE 'different@example.test' END`, { targets: [emailOnly, otherEmail], target: emailOnly, email });
    async function access(target: string, proof?: string, owner = alice) {
      const calls = [request(app).get(`${path(target)}/profile`), request(app).get(path(target)), request(app).put(path(target)).send({ name: 'Email friend' })];
      return Promise.all(calls.map(call => {
        call.set('Authorization', token(owner));
        if (proof !== undefined) call.set('X-OpenChat-Discovery-Email', encodeURIComponent(proof));
        return call;
      }));
    }
    for (const proof of [undefined, 'exact', '@example.test', 'wrong@example.test', 'name', 'a@b', 'a b@example.test']) {
      expect((await access(emailOnly, proof)).map(res => res.status)).toEqual([404, 404, 404]);
    }
    const search = await request(app).get('/api/chat/search').query({ q: email }).set('Authorization', token(alice));
    expect(search.body.contacts.some((person: { id: string }) => person.id === emailOnly)).toBe(true);
    const allowed = await access(emailOnly, ` ${email.toUpperCase()} `);
    expect(allowed.map(res => res.status)).toEqual([200, 200, 200]);
    expect(allowed[0].body).toEqual({ id: emailOnly, name: 'Official Name', avatarUrl: null, isBot: false });
    expect((await access(emailOnly)).map(res => res.status)).toEqual([404, 404, 404]);
    expect((await access(otherEmail, email)).map(res => res.status)).toEqual([404, 404, 404]);
    expect((await request(app).get(path(emailOnly)).set('Authorization', token(mallory)).set('X-OpenChat-Discovery-Email', encodeURIComponent(email))).body).toEqual({ name: null });
    const stored = await run(`MATCH (u:User {id: $target}) OPTIONAL MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation) WITH u, count(c) AS conversations MATCH (:User {id: $owner})-[r:OPENCHAT_PRIVATE_NAME]->(u) RETURN properties(r) AS alias, u.name AS name, conversations`, { target: emailOnly, owner: alice });
    expect(stored.records[0].get('alias')).toEqual({ name: 'Email friend' });
    expect(stored.records[0].get('name')).toBe('Official Name');
    expect(stored.records[0].get('conversations').toNumber()).toBe(0);
    await run(`MATCH (u:User {id: $target}) SET u.email = 'changed@example.test'`, { target: emailOnly });
    expect((await access(emailOnly, email)).map(res => res.status)).toEqual([404, 404, 404]);
    await run(`MATCH (u:User {id: $target}) SET u.email = $email, u.discoveryMode = 'hidden'`, { target: emailOnly, email });
    expect((await access(emailOnly, email)).map(res => res.status)).toEqual([404, 404, 404]);
    await run(`MATCH (u:User {id: $target}) SET u.discoveryMode = 'email_only', u.isBot = true`, { target: emailOnly });
    expect((await access(emailOnly, email)).map(res => res.status)).toEqual([404, 404, 404]);
    await run(`MATCH (u:User {id: $target}) SET u.isBot = false`, { target: emailOnly });
    expect((await access(emailOnly, email, emailOnly)).map(res => res.status)).toEqual([404, 404, 404]);
    for (const reverse of [false, true]) {
      await run(`MATCH (a:User {id: $a}), (b:User {id: $b}) CREATE (a)-[:BLOCKED]->(b)`, { a: reverse ? emailOnly : alice, b: reverse ? alice : emailOnly });
      expect((await access(emailOnly, email)).map(res => res.status)).toEqual([404, 404, 404]);
      await run(`MATCH (:User {id: $a})-[r:BLOCKED]->(:User {id: $b}) DELETE r`, { a: reverse ? emailOnly : alice, b: reverse ? alice : emailOnly });
    }
  });
  it('stores per-owner aliases, resists forged owner IDs and preserves official name changes', async () => {
    const put = await request(app).put(path(bob)).set('Authorization', token(alice)).send({ name: ' My Buddy ', ownerId: mallory });
    expect(put.status).toBe(200); expect(put.body).toEqual({ name: 'My Buddy' });
    const own = await request(app).get(path(bob)).set('Authorization', token(alice));
    expect(own.body).toEqual({ name: 'My Buddy' }); expect(own.headers['cache-control']).toBe('no-store');
    expect((await request(app).get(`${path(bob)}?ownerId=${alice}`).set('Authorization', token(mallory))).body).toEqual({ name: null });
    expect((await request(app).get(path(alice)).set('Authorization', token(bob))).body).toEqual({ name: null });
    await request(app).put(path(bob)).set('Authorization', token(mallory)).send({ name: 'Colleague' });
    await request(app).delete(`${path(bob)}?ownerId=${alice}`).set('Authorization', token(mallory));
    expect((await request(app).get(path(bob)).set('Authorization', token(alice))).body.name).toBe('My Buddy');
    await run(`MATCH (u:User {id: $bob}) SET u.name = 'Updated Official'`, { bob });
    expect((await request(app).get(path(bob)).set('Authorization', token(alice))).body.name).toBe('My Buddy');
    expect((await run(`MATCH (u:User {id: $bob}) RETURN u.name AS name`, { bob })).records[0].get('name')).toBe('Updated Official');
    await request(app).put(path(bob)).set('Authorization', token(alice)).send({ name: 'New Buddy' });
    expect((await request(app).get(path(bob)).set('Authorization', token(alice))).body.name).toBe('New Buddy');
  });
  it('never projects an alias into cards or vCards, including for its owner', async () => {
    const card = await request(app).get('/api/card/me').set('Authorization', token(bob));
    expect(card.status).toBe(200);
    for (const owner of [alice, mallory]) {
      const publicCard = await request(app).get(`/api/card/${card.body.token}`).set('Authorization', token(owner));
      expect(publicCard.status).toBe(200); expect(publicCard.body.name).toBe('Updated Official');
      expect(JSON.stringify(publicCard.body)).not.toContain('New Buddy');
      const vcard = await request(app).get(`/api/card/${card.body.token}/contact.vcf`).set('Authorization', token(owner));
      expect(vcard.status).toBe(200); expect(vcard.text).toContain('Updated Official');
      expect(vcard.text).not.toContain('New Buddy');
    }
  });
  it('keeps search, conversation export and share URLs on official names', async () => {
    for (const owner of [alice, mallory]) {
      const directory = await request(app).get('/api/chat/contacts?q=Updated').set('Authorization', token(owner));
      expect(directory.status).toBe(200);
      expect(directory.body.find((person: { id: string }) => person.id === bob).name).toBe('Updated Official');
      expect(JSON.stringify(directory.body)).not.toContain('New Buddy');
      const aliasSearch = await request(app).get('/api/chat/contacts?q=New%20Buddy').set('Authorization', token(owner));
      expect(aliasSearch.body).toEqual([]);
    }
    const exported = await request(app).get(`/api/chat/conversations/${conversationId}/export?range=all_time`).set('Authorization', token(alice));
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain('Updated Official');
    expect(JSON.stringify(exported.body)).not.toContain('New Buddy');
    const card = await request(app).get('/api/card/me').set('Authorization', token(bob));
    expect(card.body.token).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(JSON.stringify(card.body)).not.toContain('New Buddy');
  });
  it('rejects hidden, blocked, missing, bot, self, and device-only targets; can clear after blocking/deletion', async () => {
    for (const id of [hidden, bot, alice, 'unlinked-device-id']) {
      expect((await request(app).put(path(id)).set('Authorization', token(alice)).send({ name: 'No' })).status).toBe(404);
      expect((await request(app).get(path(id)).set('Authorization', token(alice))).status).toBe(404);
    }
    await run(`MATCH (a:User {id: $alice}), (b:User {id: $bob}) CREATE (b)-[:BLOCKED]->(a)`, { alice, bob });
    expect((await request(app).get(path(bob)).set('Authorization', token(alice))).status).toBe(404);
    expect((await request(app).put(path(bob)).set('Authorization', token(alice)).send({ name: 'No' })).status).toBe(404);
    expect((await request(app).delete(path(bob)).set('Authorization', token(alice))).body).toEqual({ name: null });
    await run(`MATCH (:User {id: $bob})-[r:BLOCKED]->(:User {id: $alice}) DELETE r`, { alice, bob });
    expect((await request(app).get(path(bob)).set('Authorization', token(alice))).body).toEqual({ name: null });
    await request(app).put(path(deleted)).set('Authorization', token(alice)).send({ name: 'Temporary' });
    await run(`MATCH (u:User {id: $deleted}) DETACH DELETE u`, { deleted });
    expect((await request(app).get(path(deleted)).set('Authorization', token(alice))).status).toBe(404);
    expect((await request(app).delete(path(deleted)).set('Authorization', token(alice))).body).toEqual({ name: null });
  });
  it('validates values and serializes concurrent writes to a single alias', async () => {
    for (const name of ['', '  ', null, 7, 'A'.repeat(101), 'two\nlines']) {
      expect((await request(app).put(path(bob)).set('Authorization', token(alice)).send({ name })).status).toBe(400);
    }
    await Promise.all(['First', 'Second', 'Third'].map(name => request(app).put(path(bob)).set('Authorization', token(alice)).send({ name })));
    const stored = await run(`MATCH (:User {id: $alice})-[r:OPENCHAT_PRIVATE_NAME]->(:User {id: $bob}) RETURN count(r) AS count`, { alice, bob });
    expect(stored.records[0].get('count').toNumber()).toBe(1);
  });
  it('preserves hidden-profile access through friends or shared chats, but never through a block', async () => {
    const pairKey = JSON.stringify([alice, hidden].sort());
    try {
      for (const state of ['pending', 'accepted']) {
        await run(`MERGE (c:OpenChatConnection {pairKey: $pairKey}) SET c.state = $state`, { pairKey, state });
        expect((await request(app).put(path(hidden)).set('Authorization', token(alice)).send({ name: 'Private friend' })).status).toBe(200);
        expect((await request(app).get(path(hidden)).set('Authorization', token(alice))).body).toEqual({ name: 'Private friend' });
        expect((await request(app).get(path(hidden)).set('Authorization', token(mallory))).status).toBe(404);
      }
      await run(`MATCH (c:OpenChatConnection {pairKey: $pairKey}) DELETE c`, { pairKey });
      expect((await request(app).get(path(hidden)).set('Authorization', token(alice))).status).toBe(404);
      await run(`MATCH (h:User {id: $hidden}), (c:Conversation {id: $conversationId}) CREATE (h)-[:PARTICIPATES_IN]->(c)`, { hidden, conversationId });
      expect((await request(app).get(path(hidden)).set('Authorization', token(alice))).body).toEqual({ name: 'Private friend' });
      await run(`MATCH (a:User {id: $alice}), (h:User {id: $hidden}) CREATE (a)-[:BLOCKED]->(h)`, { alice, hidden });
      expect((await request(app).get(path(hidden)).set('Authorization', token(alice))).status).toBe(404);
      expect((await request(app).put(path(hidden)).set('Authorization', token(alice)).send({ name: 'No' })).status).toBe(404);
    } finally {
      await run(`MATCH (c:OpenChatConnection {pairKey: $pairKey}) DELETE c`, { pairKey });
    }
  });
});
