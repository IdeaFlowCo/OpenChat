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
    const own = await graph.saveAsk(alice, { author: 'self', text: 'Heal my TFCC', horizon: 'evergreen' });
    expect(own.created).toBe(true);
    expect(own.ask).toMatchObject({ fromMe: true, forMe: false, authorParty: { kind: 'self' }, carrier: null, placements: [], exposure: 'only_me', status: 'open', horizon: 'evergreen', exposureConversationId: null, recordedBy: 'owner', recordedVia: 'app' });
    const again = await graph.saveAsk(alice, { author: { kind: 'self' }, text: 'heal my  TFCC' });
    expect([again.created, again.ask.id]).toEqual([false, own.ask.id]);

    const bobs = await graph.saveAsk(alice, { author: { kind: 'user', id: bob }, text: 'Looking for a co-founder', evidence: { label: 'Told me at dinner', seenAt: '2026-11-01' } },
      { author: 'agent:Test', source: 'connector', assertion: 'inferred' });
    expect(bobs.ask).toMatchObject({ fromMe: false, authorParty: { kind: 'user', id: bob, name: bob }, recordedBy: 'agent:Test', assertion: 'inferred', evidence: { label: 'Told me at dinner', seenAt: '2026-11-01', quote: null, url: null, noteId: null } });
    // The author's card shows the ask as a link.
    expect((await graph.getPersonOverlay(alice, bob)).links.map(link => [link.relation, link.relationType, link.other.kind])).toEqual([['asks', 'asks', 'ask']]);

    const maya = await graph.resolvePrivateThing(alice, { kind: 'person', name: `Maya ${suffix}` });
    const mayas = await graph.saveAsk(alice, { author: { kind: 'thing', id: maya.id }, text: 'Chiropractor in SF', horizon: 'short' });
    expect(mayas.ask.authorParty).toMatchObject({ kind: 'person', id: maya.id });
    const topic = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Neck pain ${suffix}` });
    expect(await status(() => graph.saveAsk(alice, { author: { kind: 'thing', id: topic.id }, text: 'x' }))).toBe(400);
    expect(await status(() => graph.saveAsk(alice, { author: { kind: 'user', id: alice }, text: 'x' }))).toBe(400);
    expect(await status(() => graph.saveAsk(alice, { author: { kind: 'user', id: blocked }, text: 'x' }))).toBe(200);
    expect(await status(() => graph.saveAsk(alice, { text: 'no author' }))).toBe(400);
    // Earlier clients' asker reads as author.
    expect((await graph.saveAsk(alice, { asker: 'self', text: 'Heal my TFCC' })).created).toBe(false);
    expect(await status(() => graph.saveAsk(alice, { author: 'self', text: 'x', exposureChat: 'openchat:conversation:x' }))).toBe(400);
    // Saved things never list asks.
    expect((await graph.listThings(alice, '', undefined)).things.some(thing => (thing.kind as string) === 'ask')).toBe(false);
  });

  it('lists asks owner-only, by asker, and hides asks by someone blocked', async () => {
    const session = driver.session();
    try { await session.run('MATCH (a:User {id: $alice}), (b:User {id: $blocked}) CREATE (b)-[:BLOCKED]->(a)', { alice, blocked }); } finally { await session.close(); }
    const all = await graph.listAsks(alice, {});
    expect(all.asks.map(ask => ask.text).sort()).toEqual(['Chiropractor in SF', 'Heal my TFCC', 'Looking for a co-founder']);
    expect((await graph.listAsks(alice, { direction: 'from_me' })).asks.map(ask => ask.text)).toEqual(['Heal my TFCC']);
    expect((await graph.listAsks(alice, { asker: 'self' })).asks.map(ask => ask.text)).toEqual(['Heal my TFCC']);
    expect((await graph.listAsks(alice, { direction: 'from_others' })).asks.map(ask => ask.text).sort()).toEqual(['Chiropractor in SF', 'Looking for a co-founder']);
    expect((await graph.listAsks(alice, { aboutKind: 'user', aboutId: bob })).asks.map(ask => ask.text)).toEqual(['Looking for a co-founder']);
    expect((await graph.listAsks(alice, { aboutKind: 'user', aboutId: carol })).asks).toEqual([]);
    expect((await graph.listAsks(alice, { direction: 'to_me' }).catch(error => error.status))).toBe(400);
    // Bob, the person the ask is about, sees nothing; nor does anyone else.
    expect((await graph.listAsks(bob, {})).asks).toEqual([]);
    const id = all.asks[0]!.id;
    expect(await status(() => graph.getAsk(carol, id))).toBe(404);
    expect(await status(() => graph.updateAsk(carol, id, { status: 'withdrawn' }))).toBe(404);
    expect(await status(() => graph.deleteAsk(carol, id))).toBe(404);
  });

  it('edits status, recheck and exposure; this_chat needs a conversation the owner is in', async () => {
    const [ask] = (await graph.listAsks(alice, { direction: 'from_me' })).asks;
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
    expect(await status(() => graph.updateAsk(alice, ask!.id, { author: 'self' }))).toBe(400);
    const done = await graph.updateAsk(alice, ask!.id, { status: 'fulfilled' }, { author: 'agent:Test', source: 'connector', assertion: 'stated' });
    expect([done.status, done.updatedBy, done.recordedBy]).toEqual(['fulfilled', 'agent:Test', 'owner']);
    expect((await graph.listAsks(alice, { direction: 'from_me' })).asks).toEqual([]);
    expect((await graph.listAsks(alice, { direction: 'from_me', status: 'fulfilled,closed' })).asks.map(value => value.id)).toEqual([ask!.id]);
  });

  it('who cares, who carries and where it was placed: from me, for me, about a person', async () => {
    const dee = await graph.resolvePrivateThing(alice, { kind: 'person', name: `Dee ${suffix}` });
    // Bob asked me in our chat: Bob cares, it is placed on my stream and in that conversation.
    const toMe = (await graph.saveAsk(alice, { author: { kind: 'user', id: bob }, placements: ['self', { kind: 'conversation', id: shared }], text: 'Review my pitch deck' })).ask;
    expect([toMe.fromMe, toMe.forMe, toMe.placements]).toEqual([false, true, [{ kind: 'self' }, { kind: 'conversation', conversationId: shared }]]);
    // My own, handed to Dee.
    const handed = (await graph.saveAsk(alice, { author: 'self', carrier: { kind: 'thing', id: dee.id }, text: 'Book the venue' })).ask;
    expect([handed.fromMe, handed.forMe, handed.carrier]).toEqual([true, false, expect.objectContaining({ kind: 'person', id: dee.id })]);
    const texts = async (input: Record<string, unknown>) => (await graph.listAsks(alice, input)).asks.map(ask => ask.text).sort();
    expect(await texts({ direction: 'for_me' })).toEqual(['Review my pitch deck']);
    expect(await texts({ direction: 'from_me' })).toContain('Book the venue');
    expect(await texts({ aboutKind: 'thing', aboutId: dee.id })).toEqual(['Book the venue']);
    expect(await texts({ aboutKind: 'user', aboutId: bob })).toContain('Review my pitch deck');
    // Placing in a conversation needs one the owner is in; a carrier must be able to act.
    expect(await status(() => graph.saveAsk(alice, { author: 'self', text: 'x', placements: [{ kind: 'conversation', id: foreign }] }))).toBe(404);
    const project = await graph.resolvePrivateThing(alice, { kind: 'project', name: `Proj ${suffix}` });
    expect(await status(() => graph.saveAsk(alice, { author: 'self', text: 'x', carrier: { kind: 'thing', id: project.id } }))).toBe(400);
    // Handing over to an OpenChat person, then taking it back.
    expect((await graph.updateAsk(alice, handed.id, { carrier: { kind: 'user', id: bob } })).carrier).toMatchObject({ kind: 'user', id: bob });
    const back = await graph.updateAsk(alice, handed.id, { carrier: 'self' });
    expect([back.carrier, back.forMe]).toEqual([{ kind: 'self' }, true]);
    // Bob still sees none of it.
    expect((await graph.listAsks(bob, { direction: 'for_me', status: 'all' })).asks).toEqual([]);
  });

  it('forgets an ask, and a saved person\'s asks with them', async () => {
    const mine = await graph.saveAsk(alice, { author: 'self', text: 'Temporary' });
    expect(await graph.deleteAsk(alice, mine.ask.id)).toEqual({ deleted: true, id: mine.ask.id });
    expect(await status(() => graph.getAsk(alice, mine.ask.id))).toBe(404);
    const [mayas] = (await graph.listAsks(alice, { q: 'chiropractor' })).asks;
    await graph.deletePrivateThing(alice, (mayas!.author as { id: string }).id);
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
    expect((await graph.listAsks(alice, { aboutKind: 'thing', aboutId: friend.id })).asks).toEqual([]);
    const first = await migrateAsksToOverlay(driver, 'neo4j', { apply: true });
    expect(first.friendAskNotes.skipped.some(skip => skip.reason.includes('topic'))).toBe(true);
    expect(first.legacyAsks.reviewsRepointed).toBe(1);
    const asks = (await graph.listAsks(alice, { aboutKind: 'thing', aboutId: friend.id, status: 'all' })).asks;
    const byText = new Map(asks.map(ask => [ask.text, ask]));
    expect(byText.get('A physio in Oakland')).toMatchObject({ horizon: 'short', status: 'open', recordedBy: 'agent:Monitor', recordedVia: 'connector', evidence: { noteId: multi.id, seenAt: '2026-10-29' } });
    expect(byText.get('Resources for a long-term condition')).toMatchObject({ horizon: 'evergreen', exposure: 'only_me' });
    expect(byText.get('Meet local founders')).toMatchObject({ status: 'stale', revision: 1, recordedVia: 'suggestion' });
    expect((await graph.listAsks(alice, { aboutKind: 'thing', aboutId: monitor.id })).asks.map(ask => ask.text)).toEqual(['on a project: migrated as the project asking']);
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
    expect((await graph.listAsks(alice, { aboutKind: 'thing', aboutId: friend.id, status: 'all' })).asks).toHaveLength(3);
  });

  it('a migrated ask that already existed leaves its review ledger alone, so undo never deletes it', async () => {
    const { migrateAsksToOverlay } = await import('../src/services/askMigration.js');
    const review = await import('../src/services/privateNoteReview.js');
    const person = await graph.resolvePrivateThing(alice, { kind: 'person', name: `Kim ${suffix}` });
    const existing = await graph.saveAsk(alice, { author: { kind: 'thing', id: person.id }, text: 'Find a climbing partner' });
    const ownerKey = (await graph.privateReviewPrincipal(alice)).ownerKey;
    const legacyId = `legacy-dup-${suffix}`, reviewId = `review-dup-${suffix}`;
    const session = driver.session();
    try {
      await session.run(`CREATE (:OpenChatPrivateAsk {id: $legacyId, ownerKey: $ownerKey, entityId: $entityId, text: 'Find a climbing partner', audience: 'owner', status: 'active', revision: 0, reviewId: $reviewId, createdAt: '2026-10-21T00:00:00.000Z'}),
        (:OpenChatNoteReview {id: $reviewId, ownerKey: $ownerKey, entityId: $entityId, requestId: $reviewId, audience: 'owner', payload: $payload})`,
      { legacyId, ownerKey, entityId: person.id, reviewId, payload: JSON.stringify({ id: reviewId, subject: { kind: 'thing', id: person.id }, status: 'applied', createdRecords: [{ id: legacyId, kind: 'ask', suggestionId: 's1' }] }) });
    } finally { await session.close(); }
    const report = await migrateAsksToOverlay(driver, 'neo4j', { apply: true });
    expect(report.legacyAsks.existing).toBe(1);
    await review.undoNoteReview(alice, reviewId);
    expect((await graph.getAsk(alice, existing.ask.id)).text).toBe('Find a climbing partner');
  });

  it('a topic card keeps its asks: listed on the card, linked, and gone with the topic', async () => {
    const review = await import('../src/services/privateNoteReview.js');
    const topic = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Bouldering ${suffix}` });
    const other = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Climbing ${suffix}` });
    for (const [subject, key] of [[topic, 'topic-a'], [other, 'topic-b']] as const) {
      const batch = await review.captureNoteReview(alice, { kind: 'thing', id: subject.id }, { text: 'Find a bouldering gym', requestId: key, asStandingAsk: true });
      await review.applyNoteReview(alice, batch.id, { suggestionIds: [batch.suggestions[0]!.id] });
    }
    const onTopic = (await review.listNoteReviews(alice, { kind: 'thing', id: topic.id })).asks;
    const onOther = (await review.listNoteReviews(alice, { kind: 'thing', id: other.id })).asks;
    expect(onTopic.map(ask => ask.text)).toEqual(['Find a bouldering gym']);
    expect(onOther.map(ask => ask.id)).toEqual(onTopic.map(ask => ask.id));
    // Linked to two topics: deleting one keeps it; deleting the last takes it.
    await graph.deletePrivateThing(alice, topic.id);
    expect((await graph.getAsk(alice, onOther[0]!.id)).fromMe).toBe(true);
    await graph.deletePrivateThing(alice, other.id);
    expect(await status(() => graph.getAsk(alice, onOther[0]!.id))).toBe(404);
  });

  it('a refused ask leaves no person card; search hides a blocked author’s ask; undo removes a topic link it added', async () => {
    const review = await import('../src/services/privateNoteReview.js');
    const ownerKey = (await graph.privateReviewPrincipal(alice)).ownerKey;
    const refs = async (userId: string) => {
      const session = driver.session();
      try { return Number((await session.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN count(r) AS n', { ownerKey, ref: `openchat:user:${userId}` })).records[0]!.get('n')); } finally { await session.close(); }
    };
    expect(await refs(carol)).toBe(0);
    expect(await status(() => graph.saveAsk(alice, { author: { kind: 'user', id: carol }, text: '   ' }))).toBe(400);
    expect(await status(() => graph.saveAsk(alice, { author: 'self', carrier: { kind: 'user', id: carol }, text: 'x', horizon: 'soon' }))).toBe(400);
    expect(await status(() => graph.updateAsk(alice, 'no-such-ask-id', { carrier: { kind: 'user', id: carol } }))).toBe(404);
    expect(await refs(carol)).toBe(0);

    // The blocked person's ask (saved before the block) is out of search as it is out of the lists.
    const hidden = (await graph.listAsks(alice, { status: 'all', q: 'x' })).asks;
    expect(hidden.every(ask => !(ask.authorParty.kind === 'user' && ask.authorParty.id === blocked))).toBe(true);
    expect((await graph.searchPrivate(alice, { kind: 'ask' })).things.some(thing => thing.name === 'x')).toBe(false);

    // A topic card adopting an ask the owner already had: undo removes only that link.
    const topic = await graph.resolvePrivateThing(alice, { kind: 'topic', name: `Fresh ${suffix}` });
    await graph.saveAsk(alice, { author: 'self', text: 'Learn to sail' });
    const batch = await review.captureNoteReview(alice, { kind: 'thing', id: topic.id }, { text: 'Learn to sail', requestId: 'adopt-1', asStandingAsk: true });
    const applied = await review.applyNoteReview(alice, batch.id, { suggestionIds: [batch.suggestions[0]!.id] });
    expect(applied.createdRecords?.map(record => record.kind)).toEqual(['connection']);
    expect((await review.listNoteReviews(alice, { kind: 'thing', id: topic.id })).asks.map(ask => ask.text)).toEqual(['Learn to sail']);
    await review.undoNoteReview(alice, batch.id);
    expect((await review.listNoteReviews(alice, { kind: 'thing', id: topic.id })).asks).toEqual([]);
    expect((await graph.listAsks(alice, { direction: 'from_me', q: 'sail' })).asks).toHaveLength(1);
  });
});
