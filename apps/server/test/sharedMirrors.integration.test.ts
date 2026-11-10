import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

/**
 * Sharing one imported chat into a group conversation, its one-chat sync
 * token, and the conversation's link resources (OpenChat-c8to). Entirely
 * invented data: no real chat content belongs in git.
 */
integration('shared chat mirrors and link resources — real Neo4j + HTTP', { timeout: 60_000 }, () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [owner, member, outsider] = ['owner', 'member', 'outsider'].map(id => `mirror-${id}-${suffix}`);
  const [group, otherGroup, direct] = ['group', 'other', 'direct'].map(id => `mirror-conv-${id}-${suffix}`);
  const app = express();
  let driver: Driver;
  let db: typeof import('../src/db.js');
  let resources: typeof import('../src/services/conversationResources.js');
  let chatId: string;
  let shareId: string;
  let syncToken: string;
  const fetched: string[] = [];

  const source = { network: 'imessage', accountKey: `acct-${suffix}`, chatKey: `thread-${suffix}`, chatType: 'group', title: 'Synthetic study group' };
  const payload = (messages: unknown[], asOf = '2026-11-01T12:00:00.000Z') => ({
    schemaVersion: 1, source,
    coverage: { asOf, method: 'synthetic-fixture', complete: false },
    participants: [
      { sourceKey: 'p-owner', displayName: 'Owner Example', nameSource: 'owner', isOwner: true },
      { sourceKey: 'p-ada', displayName: 'Ada Example', nameSource: 'contact' },
    ],
    messages,
  });
  const text = (id: string, senderKey: string, sentAt: string, body: string) => ({ sourceMessageId: id, senderKey, sentAt, kind: 'text', text: body });
  const first = [
    text('g-1', 'p-ada', '2026-10-30T10:00:00.000Z', 'Have you read https://dl.acm.org/doi/10.1145/1111111 ?'),
    text('g-2', 'p-owner', '2026-10-30T10:05:00.000Z', 'Yes. Also http://www.example.org/garden/?utm_source=chat and https://ada.example.edu/'),
    text('g-3', 'p-ada', '2026-10-30T10:06:00.000Z', 'Great, no link in this one'),
  ];

  const bearer = (id: string) => `Bearer ${jwt.sign({ userId: id, email: `${id}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
  const as = (auth: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', auth),
    put: (path: string, body?: unknown) => request(app).put(path).set('Authorization', auth).send((body ?? {}) as object),
    post: (path: string, body?: unknown) => request(app).post(path).set('Authorization', auth).send((body ?? {}) as object),
    patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', auth).send(body as object),
    delete: (path: string) => request(app).delete(path).set('Authorization', auth),
  });
  const conv = (id: string) => `/api/chat/conversations/${id}`;
  async function run(query: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(query, params); } finally { await session.close(); }
  }
  const count = async (query: string, params: Record<string, unknown> = {}) => Number((await run(query, params)).records[0]!.get(0));

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    db = await import('../src/db.js');
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    resources = await import('../src/services/conversationResources.js');
    // Never touch the public web from a test: titles come from this table.
    resources.setResourcePreviewFetcher(async url => {
      fetched.push(url);
      if (url.includes('dl.acm.org')) return { title: 'A Study of Shared Knowledge Graphs', description: 'Research on knowledge graphs.', siteName: 'ACM' };
      if (url.includes('ada.example.edu')) return { title: 'Ada Example', description: 'Professor of human-computer interaction.' };
      return null;
    });
    const session = db.getDriver().session();
    try {
      await (await import('../src/services/importedChats.js')).ensureImportedChatSchema(session);
      await resources.ensureConversationResourceSchema(session);
    } finally { await session.close(); }
    const imported = await import('../src/routes/importedChats.js');
    app.use(imported.exceptImportBody(express.json()));
    app.use('/api/chat', (await import('../src/routes/conversationSources.js')).default);
    app.use('/api/imported-chats', imported.default);
    await run('UNWIND $ids AS id CREATE (:User {id: id, name: id})', { ids: [owner, member, outsider] });
    await run(`
      MATCH (o:User {id: $owner}), (m:User {id: $member}), (x:User {id: $outsider})
      CREATE (g:Conversation {id: $group, type: 'group', title: 'Synthetic study group'}), (og:Conversation {id: $otherGroup, type: 'group', title: 'Other'}), (d:Conversation {id: $direct, type: 'direct'})
      CREATE (o)-[:PARTICIPATES_IN {role: 'owner'}]->(g), (m)-[:PARTICIPATES_IN {role: 'member'}]->(g)
      CREATE (m)-[:PARTICIPATES_IN {role: 'owner'}]->(og), (o)-[:PARTICIPATES_IN {role: 'member'}]->(og)
      CREATE (o)-[:PARTICIPATES_IN {role: 'owner'}]->(d), (x)-[:PARTICIPATES_IN {role: 'member'}]->(d)`,
      { owner, member, outsider, group, otherGroup, direct });
    const res = await as(bearer(owner)).put('/api/imported-chats/import', payload(first));
    expect(res.status).toBe(201);
    chatId = res.body.chatId;
  });

  afterAll(async () => {
    if (!driver) return;
    resources.setResourcePreviewFetcher();
    await run('MATCH (r:ConversationResource) WHERE r.conversationId IN $ids DETACH DELETE r', { ids: [group, otherGroup, direct] });
    await run('MATCH (n) WHERE n.ownerUserId = $owner AND any(l IN labels(n) WHERE l STARTS WITH "OpenChatImported") DETACH DELETE n', { owner });
    await run('MATCH (m:Message) WHERE m.conversationId IN $ids DETACH DELETE m', { ids: [group, otherGroup, direct] });
    await run('MATCH (c:Conversation) WHERE c.id IN $ids DETACH DELETE c', { ids: [group, otherGroup, direct] });
    await run('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u', { ids: [owner, member, outsider] });
    await driver.close(); await db.closeDatabase();
  });

  it('shows members nothing until the owner shares', async () => {
    const sources = await as(bearer(member)).get(`${conv(group)}/sources`);
    expect(sources.status).toBe(200);
    expect(sources.body).toEqual({ sources: [], resourcesEnabled: false });
    expect((await as(bearer(member)).get(`${conv(group)}/resources`)).body).toEqual({ enabled: false, resources: [], pending: 0 });
    expect((await as(bearer(outsider)).get(`${conv(group)}/sources`)).status).toBe(404);
    expect((await request(app).get(`${conv(group)}/sources`)).status).toBe(401);
  });

  it('lets only the owner of the mirror share it, and only into a group they own', async () => {
    expect((await as(bearer(member)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: group })).status).toBe(404);
    expect((await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: otherGroup })).status).toBe(400);
    expect((await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: direct })).status).toBe(400);
    expect((await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: `missing-${suffix}` })).status).toBe(404);
    expect((await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, {})).status).toBe(400);
    expect(await count('MATCH (:OpenChatImportedChat {id: $chatId})-[s:SHARED_INTO]->() RETURN count(s)', { chatId })).toBe(0);

    const shared = await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: group });
    expect(shared.status).toBe(201);
    expect(shared.body).toMatchObject({ created: true, share: { chatId, conversationId: group, conversationTitle: 'Synthetic study group' } });
    shareId = shared.body.share.id;
    const again = await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: group });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, share: { id: shareId } });
    expect(await count('MATCH (:OpenChatImportedChat {id: $chatId})-[s:SHARED_INTO]->() RETURN count(s)', { chatId })).toBe(1);
    expect((await as(bearer(owner)).get(`/api/imported-chats/${chatId}/shares`)).body).toMatchObject({ shares: [{ id: shareId, conversationId: group }], syncToken: { active: false } });
  });

  it('lets members read the mirror, with names but no source keys, pre-edit text or other owner data', async () => {
    const sources = await as(bearer(member)).get(`${conv(group)}/sources`);
    expect(sources.status).toBe(200);
    expect(sources.headers['cache-control']).toBe('no-store');
    expect(sources.body.resourcesEnabled).toBe(true);
    expect(sources.body.sources).toEqual([expect.objectContaining({
      id: shareId, network: 'imessage', title: 'Synthetic study group', messageCount: 3, sharedBy: { userId: owner, name: owner },
      participants: [expect.objectContaining({ label: 'Owner Example', isSharer: true }), expect.objectContaining({ label: 'Ada Example', isSharer: false })],
    })]);
    const messages = await as(bearer(member)).get(`${conv(group)}/sources/${shareId}/messages?limit=2`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages.map((m: { text: string }) => m.text)).toEqual(['Great, no link in this one', expect.stringContaining('example.org/garden')]);
    expect(messages.body.messages[1].sender).toMatchObject({ label: 'Owner Example', isSharer: true });
    expect(messages.body.nextCursor).toEqual(expect.any(String));
    const older = await as(bearer(member)).get(`${conv(group)}/sources/${shareId}/messages?limit=2&before=${encodeURIComponent(messages.body.nextCursor)}`);
    expect(older.body.messages).toHaveLength(1);
    const raw = JSON.stringify([sources.body, messages.body]);
    for (const secret of ['p-ada', 'p-owner', 'g-1', 'sourceMessageId', 'originalText', source.accountKey, source.chatKey, chatId]) expect(raw).not.toContain(secret);
    // The owner's private routes stay the owner's alone.
    expect((await as(bearer(member)).get(`/api/imported-chats/${chatId}/messages`)).status).toBe(404);
    expect((await as(bearer(member)).get(`/api/imported-chats/${chatId}/shares`)).status).toBe(404);
  });

  it('refuses people outside the conversation and shares addressed through the wrong conversation', async () => {
    expect((await as(bearer(outsider)).get(`${conv(group)}/sources/${shareId}/messages`)).status).toBe(404);
    expect((await as(bearer(outsider)).get(`${conv(direct)}/sources/${shareId}/messages`)).status).toBe(404);
    expect((await as(bearer(member)).get(`${conv(otherGroup)}/sources/${shareId}/messages`)).status).toBe(404);
    expect((await as(bearer(outsider)).get(`${conv(group)}/resources`)).status).toBe(404);
    expect((await as(bearer(member)).get(`${conv(otherGroup)}/sources`)).body).toEqual({ sources: [], resourcesEnabled: false });
  });

  it('collects each shared address once, guesses a kind, suggests tags and reads page titles', async () => {
    await run(`MATCH (c:Conversation {id: $group}), (m:User {id: $member})
      CREATE (:Message {id: $id1, conversationId: $group, senderId: $member, content: 'Same paper again: https://dl.acm.org/doi/10.1145/1111111#abstract and https://github.com/acme/widget', messageType: 'text', createdAt: datetime('2026-10-31T09:00:00Z')})
      CREATE (:Message {id: $id2, conversationId: $group, senderId: $member, content: 'gone https://example.org/deleted', messageType: 'text', createdAt: datetime('2026-10-31T09:01:00Z'), deletedAt: datetime()})`,
      { group, member, id1: `msg-1-${suffix}`, id2: `msg-2-${suffix}` });
    const first = await as(bearer(member)).get(`${conv(group)}/resources`);
    expect(first.status).toBe(200);
    expect(first.body.enabled).toBe(true);
    const byHost = (host: string) => first.body.resources.find((r: { host: string }) => r.host === host);
    expect(first.body.resources.map((r: { host: string }) => r.host).sort()).toEqual(['ada.example.edu', 'dl.acm.org', 'example.org', 'github.com']);
    expect(byHost('dl.acm.org')).toMatchObject({
      kind: 'paper', title: 'A Study of Shared Knowledge Graphs', shareCount: 2, sources: ['imessage', 'openchat'], saved: false, savedCount: 0, tagsEdited: false,
      firstSharedAt: '2026-10-30T10:00:00.000Z', lastSharedAt: '2026-10-31T09:00:00.000Z', firstSharedBy: { label: 'Ada Example', userId: null },
      tags: expect.arrayContaining(['paper', 'research', 'knowledge-graph']),
    });
    expect(byHost('ada.example.edu')).toMatchObject({ kind: 'person', title: 'Ada Example', firstSharedBy: { label: owner, userId: owner }, tags: expect.arrayContaining(['researcher', 'hci']) });
    expect(byHost('example.org')).toMatchObject({ url: 'http://www.example.org/garden/', title: null, sources: ['imessage'] });
    expect(byHost('github.com')).toMatchObject({ kind: 'code', sources: ['openchat'], firstSharedBy: { userId: member } });
    expect(first.body.pending).toBe(0);
    // Reading again changes nothing and fetches nothing new.
    const calls = fetched.length;
    const second = await as(bearer(owner)).get(`${conv(group)}/resources`);
    expect(second.body.resources.map((r: { id: string; shareCount: number }) => [r.id, r.shareCount])).toEqual(first.body.resources.map((r: { id: string; shareCount: number }) => [r.id, r.shareCount]));
    expect(fetched.length).toBe(calls);
    expect(await count('MATCH (r:ConversationResource {conversationId: $group}) RETURN count(r)', { group })).toBe(4);
  });

  it('lets any member edit tags and kind for everyone, and keeps Saved personal', async () => {
    const list = await as(bearer(member)).get(`${conv(group)}/resources`);
    const paper = list.body.resources.find((r: { host: string }) => r.host === 'dl.acm.org');
    const path = `${conv(group)}/resources/${paper.id}`;
    const edited = await as(bearer(member)).patch(path, { tags: ['#Reading List', 'HCI', 'hci'], kind: 'article' });
    expect(edited.status).toBe(200);
    expect(edited.body.resource).toMatchObject({ tags: ['reading-list', 'hci'], tagsEdited: true, kind: 'article', kindEdited: true, suggestedTags: paper.suggestedTags });
    expect((await as(bearer(member)).patch(path, { tags: ['<b>'] })).status).toBe(400);
    expect((await as(bearer(member)).patch(path, { kind: 'spaceship' })).status).toBe(400);
    expect((await as(bearer(member)).patch(path, {})).status).toBe(400);
    expect((await as(bearer(outsider)).patch(path, { tags: ['x'] })).status).toBe(404);
    expect((await as(bearer(member)).patch(`${conv(otherGroup)}/resources/${paper.id}`, { tags: ['x'] })).status).toBe(404);

    const saved = await as(bearer(member)).put(`${path}/saved`, { saved: true });
    expect(saved.body.resource).toMatchObject({ saved: true, savedCount: 1 });
    expect((await as(bearer(member)).put(`${path}/saved`, { saved: true })).body.resource.savedCount).toBe(1);
    expect((await as(bearer(member)).put(`${path}/saved`, { saved: 'yes' })).status).toBe(400);
    const ownerView = (await as(bearer(owner)).get(`${conv(group)}/resources`)).body.resources.find((r: { id: string }) => r.id === paper.id);
    expect(ownerView).toMatchObject({ saved: false, savedCount: 1, tags: ['reading-list', 'hci'], kind: 'article' });
    expect((await as(bearer(member)).put(`${path}/saved`, { saved: false })).body.resource).toMatchObject({ saved: false, savedCount: 0 });
  });

  it('issues a one-chat sync token that can only add messages to that mirror', async () => {
    expect((await as(bearer(member)).post(`/api/imported-chats/${chatId}/sync-token`)).status).toBe(404);
    const issued = await as(bearer(owner)).post(`/api/imported-chats/${chatId}/sync-token`);
    expect(issued.status).toBe(201);
    syncToken = issued.body.token;
    expect(syncToken).toMatch(/^ocm_/);
    expect(await count('MATCH (c:OpenChatImportedChat {id: $chatId}) WHERE c.syncTokenHash IS NOT NULL AND c.syncTokenHash <> $token RETURN count(c)', { chatId, token: syncToken })).toBe(1);

    const next = [...first, text('g-4', 'p-ada', '2026-11-02T08:00:00.000Z', 'New one: https://lu.ma/synthetic-event')];
    const sync = (token: string, body: unknown, id = chatId) => request(app).put(`/api/imported-chats/sync/${id}`).set('Authorization', `Bearer ${token}`).send(body as object);
    expect((await request(app).put(`/api/imported-chats/sync/${chatId}`).send(payload(next))).status).toBe(404);
    expect((await sync('ocm_wrong-token', payload(next))).status).toBe(404);
    expect((await sync(syncToken, payload(next), `missing-${suffix}`)).status).toBe(404);
    expect((await sync(syncToken, { ...payload(next), source: { ...source, chatKey: 'another-thread' } })).status).toBe(400);
    expect((await sync(syncToken, { ...payload(next), asks: [{ askKey: 'a', subjectKey: 'p-ada', reporterKey: 'p-ada', text: 'x', sourceMessageIds: ['g-4'], sourceStatus: 'open' }] })).status).toBe(400);
    const withFact = payload(next); (withFact.participants[1] as Record<string, unknown>).profileFacts = [{ factKey: 'f', text: 'x', sourceMessageIds: ['g-4'] }];
    expect((await sync(syncToken, withFact)).status).toBe(400);
    expect(await count('MATCH (m:OpenChatImportedMessage {chatId: $chatId}) RETURN count(m)', { chatId })).toBe(3);

    const ok = await sync(syncToken, payload(next, '2026-11-02T09:00:00.000Z'));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ dryRun: false, counts: { participants: { created: 0, updated: 0, unchanged: 2 }, messages: { created: 1, edited: 0, deleted: 0, unchanged: 3 } }, conflicts: 0 });
    // The token cannot read: neither the owner's routes nor the members' accept it.
    expect((await request(app).get(`/api/imported-chats/${chatId}/messages`).set('Authorization', `Bearer ${syncToken}`)).status).toBe(401);
    expect((await request(app).get(`${conv(group)}/sources`).set('Authorization', `Bearer ${syncToken}`)).status).toBe(401);

    // Members see the new message and its link without anyone sharing again.
    const messages = await as(bearer(member)).get(`${conv(group)}/sources/${shareId}/messages`);
    expect(messages.body.messages[0]).toMatchObject({ text: 'New one: https://lu.ma/synthetic-event' });
    const list = await as(bearer(member)).get(`${conv(group)}/resources`);
    expect(list.body.resources[0]).toMatchObject({ host: 'lu.ma', kind: 'event', sources: ['imessage'] });
    expect(list.body.resources).toHaveLength(5);
    // The member's earlier tag edit survives the re-collection.
    expect(list.body.resources.find((r: { host: string }) => r.host === 'dl.acm.org')).toMatchObject({ tags: ['reading-list', 'hci'], shareCount: 2 });

    expect((await as(bearer(owner)).delete(`/api/imported-chats/${chatId}/sync-token`)).body).toEqual({ revoked: true });
    expect((await sync(syncToken, payload(next, '2026-11-02T09:00:00.000Z'))).status).toBe(404);
  });

  it('ends member access when the owner unshares, leaves, or deletes the mirror', async () => {
    // Sharer no longer in the conversation: the mirror is not readable even though the share exists.
    await run('MATCH (:User {id: $owner})-[rel:PARTICIPATES_IN]->(:Conversation {id: $group}) DELETE rel', { owner, group });
    expect((await as(bearer(member)).get(`${conv(group)}/sources`)).body.sources).toEqual([]);
    expect((await as(bearer(member)).get(`${conv(group)}/sources/${shareId}/messages`)).status).toBe(404);
    await run("MATCH (u:User {id: $owner}), (c:Conversation {id: $group}) CREATE (u)-[:PARTICIPATES_IN {role: 'owner'}]->(c)", { owner, group });
    expect((await as(bearer(member)).get(`${conv(group)}/sources`)).body.sources).toHaveLength(1);

    expect((await as(bearer(member)).delete(`/api/imported-chats/${chatId}/shares/${group}`)).body).toEqual({ unshared: false });
    expect((await as(bearer(owner)).delete(`/api/imported-chats/${chatId}/shares/${group}`)).body).toEqual({ unshared: true });
    expect((await as(bearer(member)).get(`${conv(group)}/sources`)).body.sources).toEqual([]);
    expect((await as(bearer(member)).get(`${conv(group)}/sources/${shareId}/messages`)).status).toBe(404);
    // Links already collected stay with the conversation.
    expect((await as(bearer(member)).get(`${conv(group)}/resources`)).body.resources).toHaveLength(5);

    await as(bearer(owner)).put(`/api/imported-chats/${chatId}/shares`, { conversationId: group });
    expect((await as(bearer(owner)).delete(`/api/imported-chats/${chatId}`)).status).toBe(200);
    expect((await as(bearer(member)).get(`${conv(group)}/sources`)).body.sources).toEqual([]);
    expect(await count('MATCH ()-[s:SHARED_INTO]->(:Conversation {id: $group}) RETURN count(s)', { group })).toBe(0);
  });
});
