import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/importedChat.synthetic.json', import.meta.url), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

integration('imported chat mirrors — real Neo4j + HTTP', { timeout: 60_000 }, () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [alice, mallory, bob] = ['alice', 'mallory', 'bob'].map(id => `imported-${id}-${suffix}`);
  const encryptionSecret = crypto.randomBytes(32).toString('hex');
  const readKey = `oc_${crypto.randomBytes(24).toString('base64url')}`;
  const writeKey = `oc_${crypto.randomBytes(24).toString('base64url')}`;
  const app = express();
  let driver: Driver;
  let db: typeof import('../src/db.js');
  let chatId: string;
  const payload = () => {
    const body = clone(fixture);
    body.source.accountKey = `${body.source.accountKey}-${suffix}`;
    return body;
  };
  const token = (id: string) => `Bearer ${jwt.sign({ userId: id, email: `${id}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  const as = (auth: string) => ({
    get: (path: string) => request(app).get(`/api/imported-chats${path}`).set('Authorization', auth),
    put: (path: string, body: unknown) => request(app).put(`/api/imported-chats${path}`).set('Authorization', auth).send(body as object),
    patch: (path: string, body: unknown) => request(app).patch(`/api/imported-chats${path}`).set('Authorization', auth).send(body as object),
    delete: (path: string) => request(app).delete(`/api/imported-chats${path}`).set('Authorization', auth),
  });
  async function run(query: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(query, params); } finally { await session.close(); }
  }
  const count = async (query: string, params: Record<string, unknown> = {}) => Number((await run(query, params)).records[0]!.get(0));
  const importedNodes = () => count('MATCH (n) WHERE n.ownerUserId IN $owners AND any(l IN labels(n) WHERE l STARTS WITH "OpenChatImported") RETURN count(n)', { owners: [alice, mallory] });
  const liveFootprint = () => count('MATCH (n) WHERE (n:User OR n:Conversation OR n:Message) RETURN count(n)');
  function encrypt(plain: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encryptionSecret, 'hex'), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { keyCiphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('hex'), keyIv: iv.toString('hex') };
  }

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    process.env.OC_KEY_ENCRYPTION_SECRET = encryptionSecret;
    db = await import('../src/db.js');
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = db.getDriver().session();
    try { await (await import('../src/services/importedChats.js')).ensureImportedChatSchema(session); } finally { await session.close(); }
    app.put('/api/imported-chats/import', express.json({ limit: '16mb' }));
    app.use(express.json());
    app.use('/api/imported-chats', (await import('../src/routes/importedChats.js')).default);
    await run('UNWIND $ids AS id CREATE (:User {id: id, name: id})', { ids: [alice, mallory, bob] });
    for (const [key, scopes, name] of [[readKey, ['read'], 'Reader'], [writeKey, ['read', 'write'], 'Importer']] as const) {
      const sealed = encrypt(key);
      await run('CREATE (:AgentKey {id: $id, keyPrefix: $prefix, ownerUserId: $owner, scopes: $scopes, name: $name, createdAt: $now, keyCiphertext: $c, keyIv: $iv})',
        { id: `key-${name}-${suffix}`, prefix: key.slice(0, 11), owner: alice, scopes, name, now: new Date().toISOString(), c: sealed.keyCiphertext, iv: sealed.keyIv });
    }
  });

  afterAll(async () => {
    if (!driver) return;
    await run('MATCH (n) WHERE n.ownerUserId IN $owners AND any(l IN labels(n) WHERE l STARTS WITH "OpenChatImported") DETACH DELETE n', { owners: [alice, mallory] });
    await run('MATCH (k:AgentKey) WHERE k.ownerUserId = $alice DETACH DELETE k', { alice });
    await run('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u', { ids: [alice, mallory, bob] });
    delete process.env.OC_KEY_ENCRYPTION_SECRET;
    await driver.close(); await db.closeDatabase();
  });

  it('dry run reports the plan and writes nothing', async () => {
    const before = await importedNodes();
    const res = await as(token(alice)).put('/import?dryRun=1', payload());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, chatId: null, created: true, counts: { participants: { created: 5 }, messages: { created: 6 }, asks: { created: 2 }, profileFacts: { created: 1 } } });
    expect(await importedNodes()).toBe(before);
  });

  it('imports as the authenticated owner without creating accounts, live chats or messages', async () => {
    const footprint = await liveFootprint();
    const res = await as(token(alice)).put('/import', { ...payload(), ownerUserId: mallory });
    expect(res.status).toBe(201);
    expect(res.body.counts).toEqual({
      participants: { created: 5, updated: 0, unchanged: 0 },
      messages: { created: 6, edited: 0, deleted: 0, unchanged: 0 },
      asks: { created: 2, updated: 0, unchanged: 0, markedStale: 0 },
      profileFacts: { created: 1, updated: 0, unchanged: 0, markedStale: 0 },
    });
    chatId = res.body.chatId;
    expect(await liveFootprint()).toBe(footprint);
    expect(await count('MATCH (c:OpenChatImportedChat {id: $chatId}) RETURN count(c)', { chatId })).toBe(1);
    expect(await count('MATCH (c:OpenChatImportedChat {id: $chatId, ownerUserId: $alice}) RETURN count(c)', { chatId, alice })).toBe(1);
    expect(await count('MATCH (n) WHERE n.ownerUserId = $mallory AND any(l IN labels(n) WHERE l STARTS WITH "OpenChatImported") RETURN count(n)', { mallory })).toBe(0);
    // Nothing imported is reachable through the live graph.
    expect(await count('MATCH (n)-[r]-() WHERE n.chatId = $chatId OR n.id = $chatId RETURN count(r)', { chatId })).toBe(0);

    const list = await as(token(alice)).get('/');
    expect(list.body.chats).toEqual([expect.objectContaining({
      id: chatId, network: 'whatsapp', title: 'Synthetic Garden Club',
      coverage: expect.objectContaining({ asOf: '2026-10-20T12:00:00.000Z', earliestMessageAt: '2026-10-01T09:00:00.000Z', latestMessageAt: '2026-10-04T08:00:00.000Z', complete: false, method: 'synthetic-fixture', importCount: 1 }),
      counts: { messages: 6, participants: 5, openAsks: 1 },
    })]);
  });

  it('keeps stable, separate identities: same names never merge and unknown people stay unknown', async () => {
    const people = (await as(token(alice)).get(`/${chatId}/people`)).body.people as Array<Record<string, any>>;
    expect(people).toHaveLength(5);
    expect(people[0]).toMatchObject({ displayName: 'Owner Example', isOwner: true });
    const bos = people.filter(p => p.displayName === 'Bo Example');
    expect(bos).toHaveLength(2);
    expect(new Set(bos.map(p => p.participantId)).size).toBe(2);
    const unknown = people.find(p => p.displayName === null)!;
    expect(unknown.label).toMatch(/^Unknown participant · .{4}$/);
    expect(unknown).toMatchObject({ nameSource: 'unknown', account: null, messageCount: 1, factCount: 0 });
    expect(JSON.stringify(people)).not.toContain('p-unknown');

    // Reimport keeps the same ids; an import without a name never clears one.
    const body = payload();
    body.participants = body.participants.map((p: Record<string, unknown>) => p.sourceKey === 'p-ada' ? { sourceKey: 'p-ada', nameSource: 'unknown', profileFacts: p.profileFacts } : p);
    expect((await as(token(alice)).put('/import', body)).body.counts.participants).toEqual({ created: 0, updated: 0, unchanged: 5 });
    const again = (await as(token(alice)).get(`/${chatId}/people`)).body.people as Array<Record<string, any>>;
    expect(again.map(p => p.participantId).sort()).toEqual(people.map(p => p.participantId).sort());
    expect(again.find(p => p.participantId === people.find(q => q.displayName === 'Ada Example')!.participantId)!.displayName).toBe('Ada Example');
  });

  it('is idempotent: the same payload changes nothing and duplicates nothing', async () => {
    const before = await importedNodes();
    const res = await as(token(alice)).put('/import', payload());
    expect(res.body.counts).toEqual({
      participants: { created: 0, updated: 0, unchanged: 5 },
      messages: { created: 0, edited: 0, deleted: 0, unchanged: 6 },
      asks: { created: 0, updated: 0, unchanged: 2, markedStale: 0 },
      profileFacts: { created: 0, updated: 0, unchanged: 1, markedStale: 0 },
    });
    expect(res.body.chatId).toBe(chatId);
    expect(await importedNodes()).toBe(before);
  });

  it('rejects missing source references and unknown senders atomically', async () => {
    const before = await importedNodes();
    const missingRef = payload();
    missingRef.asks[0].sourceMessageIds = ['m-does-not-exist'];
    missingRef.messages.push({ sourceMessageId: 'm-new', senderKey: 'p-ada', sentAt: '2026-10-05T08:00:00Z', kind: 'text', text: 'new' });
    const res = await as(token(alice)).put('/import', missingRef);
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ path: 'asks[0]', message: 'cites missing source message "m-does-not-exist"' }]);
    const noSource = payload();
    noSource.asks[0].sourceMessageIds = [];
    expect((await as(token(alice)).put('/import', noSource)).body.errors).toContainEqual({ path: 'asks[0].sourceMessageIds', message: 'needs at least one source message' });
    const noId = payload();
    delete noId.messages[1].sourceMessageId;
    expect((await as(token(alice)).put('/import', noId)).status).toBe(400);
    const stranger = payload();
    stranger.messages[1].senderKey = 'p-stranger';
    expect((await as(token(alice)).put('/import', stranger)).body.errors).toContainEqual({ path: 'messages[1].senderKey', message: 'names no participant "p-stranger"' });
    expect(await importedNodes()).toBe(before);
    expect(await count('MATCH (m:OpenChatImportedMessage {chatId: $chatId, sourceMessageId: "m-new"}) RETURN count(m)', { chatId })).toBe(0);
  });

  it('keeps source ids, senders and times immutable, records edits and honours deletion', async () => {
    const body = payload();
    body.messages[1].text = 'Hi all, I run a soil-health lab. (edited)';
    body.messages[1].editedAt = '2026-10-01T10:00:00Z';
    body.messages[2].sentAt = '2026-10-01T09:11:00Z';
    body.messages[4] = { sourceMessageId: 'm-5', senderKey: 'p-twin', sentAt: '2026-10-03T11:00:00.000Z', kind: 'deleted' };
    const res = await as(token(alice)).put('/import', body);
    expect(res.body.counts.messages).toEqual({ created: 0, edited: 1, deleted: 1, unchanged: 3 });
    expect(res.body.conflicts).toEqual([{ sourceMessageId: 'm-3', field: 'sentAt', message: expect.any(String) }]);
    const messages = (await as(token(alice)).get(`/${chatId}/messages?limit=200`)).body.messages as Array<Record<string, any>>;
    const byId = Object.fromEntries(messages.map(m => [m.sourceMessageId, m]));
    expect(byId['m-2']).toMatchObject({ text: 'Hi all, I run a soil-health lab. (edited)', edited: true, editedAt: '2026-10-01T10:00:00.000Z', originalText: expect.stringContaining('Looking for a co-founder'), sentAt: '2026-10-01T09:05:00.000Z', sender: expect.objectContaining({ displayName: 'Ada Example' }) });
    expect(byId['m-3']).toMatchObject({ sentAt: '2026-10-01T09:10:00.000Z', text: expect.stringContaining('compost') });
    expect(byId['m-5']).toMatchObject({ kind: 'deleted', text: null, originalText: null, deletedAtSource: expect.any(String) });
    // A deletion is final: the original text cannot come back.
    const restore = (await as(token(alice)).put('/import', payload())).body;
    expect(restore.counts.messages).toMatchObject({ edited: 1, deleted: 0 });
    const m5 = ((await as(token(alice)).get(`/${chatId}/messages?limit=200`)).body.messages as Array<Record<string, any>>).find(m => m.sourceMessageId === 'm-5');
    expect(m5).toMatchObject({ kind: 'deleted', text: null });
  });

  it('pages messages newest first with a cursor', async () => {
    const first = await as(token(alice)).get(`/${chatId}/messages?limit=4`);
    expect(first.body.messages.map((m: { sourceMessageId: string }) => m.sourceMessageId)).toEqual(['m-6', 'm-5', 'm-4', 'm-3']);
    const second = await as(token(alice)).get(`/${chatId}/messages?limit=4&before=${first.body.nextCursor}`);
    expect(second.body.messages.map((m: { sourceMessageId: string }) => m.sourceMessageId)).toEqual(['m-2', 'm-1']);
    expect(second.body.nextCursor).toBeNull();
    expect((await as(token(alice)).get(`/${chatId}/messages?before=nonsense`)).status).toBe(400);
  });

  it('attributes asks to subject and reporter, preserves owner status and marks unlisted asks stale', async () => {
    const asks = (await as(token(alice)).get(`/${chatId}/asks`)).body.asks as Array<Record<string, any>>;
    const cofounder = asks.find(a => a.text.includes('co-founder'))!;
    const compost = asks.find(a => a.text.includes('compost'))!;
    expect(cofounder).toMatchObject({ subject: expect.objectContaining({ displayName: 'Ada Example' }), reporter: expect.objectContaining({ displayName: 'Ada Example' }), status: 'open', ownerStatus: null, stale: false });
    expect(cofounder.sources).toEqual([expect.objectContaining({ sourceMessageId: 'm-2', available: true, sender: expect.objectContaining({ displayName: 'Ada Example' }) })]);
    expect(compost).toMatchObject({ subject: null, subjectLabel: 'Cy', reporter: expect.objectContaining({ displayName: 'Bo Example' }), status: 'needs_review' });

    const resolved = await as(token(alice)).patch(`/${chatId}/asks/${cofounder.id}`, { ownerStatus: 'resolved' });
    expect(resolved.body.ask).toMatchObject({ ownerStatus: 'resolved', sourceStatus: 'open', status: 'resolved' });
    expect((await as(token(alice)).patch(`/${chatId}/asks/${cofounder.id}`, { ownerStatus: 'done' })).status).toBe(400);

    // Reimport: the source still says open; the owner's status survives. The compost ask is not listed although m-3 is re-sent.
    const body = payload();
    body.asks = [body.asks[0]];
    const res = await as(token(alice)).put('/import', body);
    expect(res.body.counts.asks).toEqual({ created: 0, updated: 0, unchanged: 1, markedStale: 1 });
    const after = (await as(token(alice)).get(`/${chatId}/asks`)).body.asks as Array<Record<string, any>>;
    expect(after.find(a => a.id === cofounder.id)).toMatchObject({ ownerStatus: 'resolved', sourceStatus: 'open', status: 'resolved' });
    expect(after.find(a => a.id === compost.id)).toMatchObject({ stale: true });
    // An import that does not re-send the evidence does not mark anything stale; listing it again clears stale.
    const partial = payload();
    partial.messages = partial.messages.filter((m: { sourceMessageId: string }) => m.sourceMessageId !== 'm-3');
    partial.asks = [{ ...partial.asks[0], sourceStatus: 'resolved', statusSourceMessageIds: ['m-6'] }];
    expect((await as(token(alice)).put('/import', partial)).body.counts.asks).toMatchObject({ updated: 1, markedStale: 0 });
    expect((await as(token(alice)).put('/import', payload())).body.counts.asks).toMatchObject({ updated: 2, markedStale: 0 });
    const final = (await as(token(alice)).get(`/${chatId}/asks`)).body.asks as Array<Record<string, any>>;
    expect(final.find(a => a.id === compost.id)).toMatchObject({ stale: false });
    expect(final.find(a => a.id === cofounder.id)).toMatchObject({ ownerStatus: 'resolved', status: 'resolved' });
  });

  it('gives every participant a small evidenced profile and links accounts only on owner confirmation', async () => {
    const people = (await as(token(alice)).get(`/${chatId}/people`)).body.people as Array<Record<string, any>>;
    const ada = people.find(p => p.displayName === 'Ada Example')!;
    const unknown = people.find(p => p.displayName === null)!;
    const profile = (await as(token(alice)).get(`/${chatId}/people/${ada.participantId}`)).body;
    expect(profile.person).toMatchObject({ participantId: ada.participantId, account: null, factCount: 1, askCount: 1 });
    expect(profile.facts).toEqual([expect.objectContaining({ text: 'Runs a soil-health lab', stale: false, sources: [expect.objectContaining({ sourceMessageId: 'm-2', available: true })] })]);
    expect(profile.asksAbout).toHaveLength(1);
    expect(profile.chat.coverage).toMatchObject({ asOf: '2026-10-20T12:00:00.000Z' });
    const unknownProfile = (await as(token(alice)).get(`/${chatId}/people/${unknown.participantId}`)).body;
    expect(unknownProfile).toMatchObject({ facts: [], asksAbout: [], person: { displayName: null, account: null } });
    expect(unknownProfile.recentMessages).toEqual([expect.objectContaining({ kind: 'media', mediaType: 'image' })]);

    expect((await as(`Bearer ${writeKey}`).patch(`/${chatId}/people/${ada.participantId}`, { linkedUserId: bob })).status).toBe(404);
    expect((await as(token(alice)).patch(`/${chatId}/people/${ada.participantId}`, { linkedUserId: 'nobody-here' })).status).toBe(404);
    const linked = await as(token(alice)).patch(`/${chatId}/people/${ada.participantId}`, { linkedUserId: bob });
    expect(linked.status).toBe(200);
    expect(linked.body.person.account).toMatchObject({ userId: bob, name: bob, linkedBy: 'owner' });
    // A link grants the linked account nothing.
    expect((await as(token(bob)).get(`/${chatId}`)).status).toBe(404);
    expect((await as(token(bob)).get('/')).body.chats).toEqual([]);
    // Reimport never changes a link.
    await as(token(alice)).put('/import', payload());
    expect((await as(token(alice)).get(`/${chatId}/people/${ada.participantId}`)).body.person.account).toMatchObject({ userId: bob });
    expect((await as(token(alice)).patch(`/${chatId}/people/${ada.participantId}`, { linkedUserId: null })).body.person.account).toBeNull();
  });

  it('denies every other owner, and keeps a second owner’s import separate', async () => {
    const people = (await as(token(alice)).get(`/${chatId}/people`)).body.people as Array<Record<string, any>>;
    const asks = (await as(token(alice)).get(`/${chatId}/asks`)).body.asks as Array<Record<string, any>>;
    const m = as(token(mallory));
    for (const res of [
      await m.get(`/${chatId}`), await m.get(`/${chatId}/messages`), await m.get(`/${chatId}/people`), await m.get(`/${chatId}/asks`),
      await m.get(`/${chatId}/people/${people[0]!.participantId}`), await m.patch(`/${chatId}/asks/${asks[0]!.id}`, { ownerStatus: 'withdrawn' }),
      await m.patch(`/${chatId}/people/${people[0]!.participantId}`, { linkedUserId: mallory }), await m.delete(`/${chatId}`),
    ]) expect(res.status).toBe(404);
    expect((await m.get('/')).body.chats).toEqual([]);
    expect((await as(token(alice)).get(`/${chatId}/asks`)).body.asks.find((a: { id: string }) => a.id === asks[0]!.id).ownerStatus).not.toBe('withdrawn');

    const theirs = await m.put('/import', payload());
    expect(theirs.status).toBe(201);
    expect(theirs.body.chatId).not.toBe(chatId);
    expect(theirs.body.counts.messages.created).toBe(6);
    expect((await as(token(alice)).get(`/${theirs.body.chatId}`)).status).toBe(404);
    expect((await m.delete(`/${theirs.body.chatId}`)).body).toEqual({ deleted: true });
    expect((await as(token(alice)).get(`/${chatId}`)).status).toBe(200);
  });

  it('honours agent key scopes and records the importing agent', async () => {
    expect((await request(app).get('/api/imported-chats')).status).toBe(401);
    expect((await as(`Bearer ${readKey}`).get(`/${chatId}/asks`)).status).toBe(200);
    expect((await as(`Bearer ${readKey}`).put('/import', payload())).status).toBe(404);
    expect((await as(`Bearer ${readKey}`).delete(`/${chatId}`)).status).toBe(404);
    const res = await as(`Bearer ${writeKey}`).put('/import', payload());
    expect(res.status).toBe(200);
    expect(res.body.chatId).toBe(chatId);
    expect((await run('MATCH (c:OpenChatImportedChat {id: $chatId}) RETURN c.lastImportedBy AS by', { chatId })).records[0]!.get('by')).toBe('agent:Importer');
  });

  it('deletes the whole mirror for its owner', async () => {
    expect((await as(token(alice)).delete(`/${chatId}`)).body).toEqual({ deleted: true });
    expect(await count('MATCH (n) WHERE n.chatId = $chatId OR n.id = $chatId RETURN count(n)', { chatId })).toBe(0);
    expect((await as(token(alice)).get(`/${chatId}`)).status).toBe(404);
  });
});
