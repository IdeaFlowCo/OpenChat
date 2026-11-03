import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

// Asks are the Noos overlay's `ask` kind (OpenChat-2fsy.1): the owner's own and
// the people they know, owner-only whatever their exposure.
integration('private asks: the overlay ask kind, seen only by its owner', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [alice, bob, carol, blocked] = ['ask-alice', 'ask-bob', 'ask-carol', 'ask-blocked'].map(prefix => `${prefix}-${suffix}`) as [string, string, string, string];
  const userIds = [alice, bob, carol, blocked];
  const shared = `ask-conv-${suffix}`, foreign = `ask-conv-other-${suffix}`;
  let driver: Driver;
  let graph: typeof import('../src/services/privateGraph.js');
  const status = async (run: () => Promise<unknown>) => { try { await run(); return 200; } catch (error) { return error instanceof graph.PrivateGraphError ? error.status : 500; } };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    graph = await import('../src/services/privateGraph.js');
    await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run('UNWIND $userIds AS userId CREATE (:User {id: userId, name: userId})', { userIds });
      await session.run(`MATCH (a:User {id: $alice}), (b:User {id: $bob}), (c:User {id: $carol})
        CREATE (a)-[:PARTICIPATES_IN]->(:Conversation {id: $shared})<-[:PARTICIPATES_IN]-(b), (c)-[:PARTICIPATES_IN]->(:Conversation {id: $foreign})`, { alice, bob, carol, shared, foreign });
    } finally { await session.close(); }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      for (const userId of userIds) await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, userId));
      await session.run('MATCH (u:User) WHERE u.id IN $userIds DETACH DELETE u', { userIds });
      await session.run('MATCH (c:Conversation) WHERE c.id IN $ids DETACH DELETE c', { ids: [shared, foreign] });
    } finally { await session.close(); }
    await driver.close();
    await (await import('../src/db.js')).getDriver().close();
  });

  it('saves the owner\'s own asks and people\'s asks once each, with only_me by default', async () => {
    const own = await graph.saveAsk(alice, { asker: 'self', text: 'Heal my TFCC', horizon: 'evergreen' });
    expect(own.created).toBe(true);
    expect(own.ask).toMatchObject({ own: true, asker: null, exposure: 'only_me', status: 'open', horizon: 'evergreen', exposureConversationId: null, author: 'owner', source: 'app' });
    const again = await graph.saveAsk(alice, { asker: { kind: 'self' }, text: 'heal my  TFCC' });
    expect([again.created, again.ask.id]).toEqual([false, own.ask.id]);

    const bobs = await graph.saveAsk(alice, { asker: { kind: 'user', id: bob }, text: 'Looking for a co-founder', evidence: { label: 'Told me at dinner', seenAt: '2026-11-01' } },
      { author: 'agent:Test', source: 'connector', assertion: 'inferred' });
    expect(bobs.ask).toMatchObject({ own: false, asker: { kind: 'user', id: bob, name: bob }, author: 'agent:Test', assertion: 'inferred', evidence: { label: 'Told me at dinner', seenAt: '2026-11-01', quote: null, url: null, noteId: null } });
    // The asker's card shows the ask as a link.
    expect((await graph.getPersonOverlay(alice, bob)).links.map(link => [link.relation, link.relationType, link.other.kind])).toEqual([['asks', 'asks', 'ask']]);

    const maya = await graph.resolvePrivateThing(alice, { kind: 'person', name: `Maya ${suffix}` });
    const mayas = await graph.saveAsk(alice, { asker: { kind: 'thing', id: maya.id }, text: 'Chiropractor in SF', horizon: 'short' });
    expect(mayas.ask.asker).toMatchObject({ kind: 'person', id: maya.id });
    const topic = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Neck pain ${suffix}` });
    expect(await status(() => graph.saveAsk(alice, { asker: { kind: 'thing', id: topic.id }, text: 'x' }))).toBe(400);
    expect(await status(() => graph.saveAsk(alice, { asker: { kind: 'user', id: alice }, text: 'x' }))).toBe(400);
    expect(await status(() => graph.saveAsk(alice, { asker: { kind: 'user', id: blocked }, text: 'x' }))).toBe(200);
    expect(await status(() => graph.saveAsk(alice, { text: 'no asker' }))).toBe(400);
    expect(await status(() => graph.saveAsk(alice, { asker: 'self', text: 'x', exposureChat: 'openchat:conversation:x' }))).toBe(400);
    // Saved things never list asks.
    expect((await graph.listThings(alice, '', undefined)).things.some(thing => (thing.kind as string) === 'ask')).toBe(false);
  });

  it('lists asks owner-only, by asker, and hides asks by someone blocked', async () => {
    const session = driver.session();
    try { await session.run('MATCH (a:User {id: $alice}), (b:User {id: $blocked}) CREATE (b)-[:BLOCKED]->(a)', { alice, blocked }); } finally { await session.close(); }
    const all = await graph.listAsks(alice, {});
    expect(all.asks.map(ask => ask.text).sort()).toEqual(['Chiropractor in SF', 'Heal my TFCC', 'Looking for a co-founder']);
    expect((await graph.listAsks(alice, { asker: 'self' })).asks.map(ask => ask.text)).toEqual(['Heal my TFCC']);
    expect((await graph.listAsks(alice, { asker: 'others' })).asks.map(ask => ask.text).sort()).toEqual(['Chiropractor in SF', 'Looking for a co-founder']);
    expect((await graph.listAsks(alice, { askerKind: 'user', askerId: bob })).asks.map(ask => ask.text)).toEqual(['Looking for a co-founder']);
    expect((await graph.listAsks(alice, { askerKind: 'user', askerId: carol })).asks).toEqual([]);
    expect((await graph.listAsks(alice, { asker: 'nobody' }).catch(error => error.status))).toBe(400);
    // Bob, the person the ask is about, sees nothing; nor does anyone else.
    expect((await graph.listAsks(bob, {})).asks).toEqual([]);
    const id = all.asks[0]!.id;
    expect(await status(() => graph.getAsk(carol, id))).toBe(404);
    expect(await status(() => graph.updateAsk(carol, id, { status: 'withdrawn' }))).toBe(404);
    expect(await status(() => graph.deleteAsk(carol, id))).toBe(404);
  });

  it('edits status, recheck and exposure; this_chat needs a conversation the owner is in', async () => {
    const [ask] = (await graph.listAsks(alice, { asker: 'self' })).asks;
    expect(await status(() => graph.updateAsk(alice, ask!.id, { exposure: 'this_chat', exposureConversationId: foreign }))).toBe(404);
    expect(await status(() => graph.updateAsk(alice, ask!.id, { exposure: 'this_chat' }))).toBe(400);
    const exposed = await graph.updateAsk(alice, ask!.id, { exposure: 'this_chat', exposureConversationId: shared });
    expect([exposed.exposure, exposed.exposureConversationId]).toEqual(['this_chat', shared]);
    // Exposure widens nothing: Bob, in that conversation, still sees no ask.
    expect((await graph.listAsks(bob, { status: 'all' })).asks).toEqual([]);
    const paused = await graph.updateAsk(alice, ask!.id, { status: 'paused' });
    expect([paused.status, paused.needsRecheck]).toEqual(['stale', true]);
    const rechecked = await graph.updateAsk(alice, ask!.id, { recheckedNow: true });
    expect([rechecked.status, rechecked.needsRecheck, rechecked.revision]).toEqual(['open', false, 3]);
    expect(await status(() => graph.updateAsk(alice, ask!.id, { asker: 'self' }))).toBe(400);
    const done = await graph.updateAsk(alice, ask!.id, { status: 'fulfilled' }, { author: 'agent:Test', source: 'connector', assertion: 'stated' });
    expect([done.status, done.updatedBy, done.author]).toEqual(['fulfilled', 'agent:Test', 'owner']);
    expect((await graph.listAsks(alice, { asker: 'self' })).asks).toEqual([]);
    expect((await graph.listAsks(alice, { asker: 'self', status: 'fulfilled,closed' })).asks.map(value => value.id)).toEqual([ask!.id]);
  });

  it('forgets an ask, and a saved person\'s asks with them', async () => {
    const mine = await graph.saveAsk(alice, { asker: 'self', text: 'Temporary' });
    expect(await graph.deleteAsk(alice, mine.ask.id)).toEqual({ deleted: true, id: mine.ask.id });
    expect(await status(() => graph.getAsk(alice, mine.ask.id))).toBe(404);
    const [mayas] = (await graph.listAsks(alice, { q: 'chiropractor' })).asks;
    await graph.deletePrivateThing(alice, mayas!.asker!.id);
    expect(await status(() => graph.getAsk(alice, mayas!.id))).toBe(404);
    // A thing that is not an ask is not deleted through the ask route.
    const topic = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Keep ${suffix}` });
    expect(await status(() => graph.deleteAsk(alice, topic.id))).toBe(404);
    expect((await graph.getThing(alice, topic.id)).id).toBe(topic.id);
  });

  it('migrates friend-ask notes and legacy note-review asks once, keeping the sources', async () => {
    const { migrateAsksToOverlay } = await import('../src/services/askMigration.js');
    const friend = await graph.resolvePrivateThing(alice, { kind: 'person', name: `Laurel ${suffix}` });
    const monitor = await graph.resolvePrivateThing(alice, { kind: 'project', name: `Asks monitor ${suffix}` });
    await graph.addLink(alice, { kind: 'thing', id: friend.id }, 'has open ask tracked in', { kind: 'project', id: monitor.id });
    const multi = await graph.addNote(alice, { kind: 'thing', id: friend.id }, '[friend-ask v1]\nask: A physio in Oakland\nsource: Facebook post, seen 2026-10-29\nstaleness: short\nstatus: open',
      { author: 'agent:Monitor', source: 'connector', assertion: 'stated' });
    await graph.addNote(alice, { kind: 'thing', id: friend.id }, '[friend-ask v1] staleness=evergreen · Resources for a long-term condition');
    await graph.addNote(alice, { kind: 'thing', id: monitor.id }, '[friend-ask v1] staleness=short · on a project: migrated as the project asking');
    const topic = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Topic ${suffix}` });
    await graph.addNote(alice, { kind: 'thing', id: topic.id }, '[friend-ask v1] staleness=short · on a topic: skipped');
    const principal = await graph.privateReviewPrincipal(alice), ownerKey = principal.ownerKey;
    const legacyId = `legacy-${suffix}`, reviewId = `review-${suffix}`;
    const session = driver.session();
    try {
      await session.run(`CREATE (:OpenChatPrivateAsk {id: $legacyId, ownerKey: $ownerKey, entityId: $entityId, text: 'Meet local founders', textKey: 'meet local founders', audience: 'owner', status: 'paused', revision: 1, reviewId: $reviewId, createdAt: '2026-10-20T00:00:00.000Z'}),
        (:OpenChatNoteReview {id: $reviewId, ownerKey: $ownerKey, entityId: $entityId, requestId: $reviewId, audience: 'owner', payload: $payload})`,
      { legacyId, ownerKey, entityId: friend.id, reviewId, payload: JSON.stringify({ id: reviewId, createdRecords: [{ id: legacyId, kind: 'ask', suggestionId: 's1' }] }) });
    } finally { await session.close(); }

    const dry = await migrateAsksToOverlay(driver, 'neo4j', { apply: false });
    expect(dry.created).toEqual([]);
    expect((await graph.listAsks(alice, { askerKind: 'thing', askerId: friend.id })).asks).toEqual([]);
    const first = await migrateAsksToOverlay(driver, 'neo4j', { apply: true });
    expect(first.friendAskNotes.skipped.some(skip => skip.reason.includes('topic'))).toBe(true);
    expect(first.legacyAsks.reviewsRepointed).toBe(1);
    const asks = (await graph.listAsks(alice, { askerKind: 'thing', askerId: friend.id, status: 'all' })).asks;
    const byText = new Map(asks.map(ask => [ask.text, ask]));
    expect(byText.get('A physio in Oakland')).toMatchObject({ horizon: 'short', status: 'open', author: 'agent:Monitor', source: 'connector', evidence: { noteId: multi.id, seenAt: '2026-10-29' } });
    expect(byText.get('Resources for a long-term condition')).toMatchObject({ horizon: 'evergreen', exposure: 'only_me' });
    expect(byText.get('Meet local founders')).toMatchObject({ status: 'stale', revision: 1, source: 'suggestion' });
    expect((await graph.listAsks(alice, { askerKind: 'thing', askerId: monitor.id })).asks.map(ask => ask.text)).toEqual(['on a project: migrated as the project asking']);
    // The ask is linked to the project tracking the friend's asks; the notes stay.
    expect((await graph.getThing(alice, monitor.id)).links.filter(link => link.relation === 'tracked in').length).toBe(2);
    expect((await graph.getThing(alice, friend.id)).notes.filter(note => note.text.startsWith('[friend-ask v1]'))).toHaveLength(2);
    const check = driver.session();
    try {
      const legacy = await check.run('MATCH (a:OpenChatPrivateAsk {id: $legacyId}) RETURN a.migratedTo AS to', { legacyId });
      expect(legacy.records[0]!.get('to')).toBe(byText.get('Meet local founders')!.id);
      const review = JSON.parse(String((await check.run('MATCH (r:OpenChatNoteReview {id: $reviewId}) RETURN r.payload AS p', { reviewId })).records[0]!.get('p')));
      expect(review.createdRecords[0].id).toBe(byText.get('Meet local founders')!.id);
    } finally { await check.close(); }
    const second = await migrateAsksToOverlay(driver, 'neo4j', { apply: true });
    expect([second.created, second.legacyAsks.seen, second.friendAskNotes.created]).toEqual([[], 0, 0]);
    expect((await graph.listAsks(alice, { askerKind: 'thing', askerId: friend.id, status: 'all' })).asks).toHaveLength(3);
  });
});
