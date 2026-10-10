import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

// unlinked-9kk.2: the overlay's rules now come from the vendored Noos store.
integration('private graph: provenance, relation edits, search and neighbourhood', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [owner, bob, carol, blocked, other] = ['pv-owner', 'pv-bob', 'pv-carol', 'pv-blocked', 'pv-other'].map(prefix => `${prefix}-${suffix}`) as [string, string, string, string, string];
  const userIds = [owner, bob, carol, blocked, other];
  const AGENT = { author: 'agent:Claude', source: 'connector', assertion: 'stated' } as const;
  const OWNER = { author: 'owner', source: 'app', assertion: 'stated' } as const;
  let driver: Driver;
  let graph: typeof import('../src/services/privateGraph.js');
  let review: typeof import('../src/services/privateNoteReview.js');
  const status = async (run: () => Promise<unknown>) => { try { await run(); return 200; } catch (error) { return error instanceof graph.PrivateGraphError ? error.status : 500; } };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    graph = await import('../src/services/privateGraph.js');
    review = await import('../src/services/privateNoteReview.js');
    await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run('UNWIND $userIds AS userId CREATE (:User {id: userId, name: userId})', { userIds });
    } finally { await session.close(); }
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      for (const userId of userIds) await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, userId));
      await session.run('MATCH (u:User) WHERE u.id IN $userIds DETACH DELETE u', { userIds });
    } finally { await session.close(); }
    await driver.close();
    await (await import('../src/db.js')).getDriver().close();
  });

  it('records who wrote a note or link; old records read back with null provenance', async () => {
    const mine = await graph.addNote(owner, { kind: 'user', id: bob }, 'Met at the climate dinner');
    expect(mine).toMatchObject({ author: 'owner', source: 'app', assertion: 'stated' });
    const agents = await graph.addNote(owner, { kind: 'user', id: bob }, 'Prefers mornings', AGENT);
    expect(agents).toMatchObject({ author: 'agent:Claude', source: 'connector' });
    expect((await graph.addNote(owner, { kind: 'user', id: bob }, 'Prefers mornings')).id).toBe(agents.id);
    const link = await graph.addLink(owner, { kind: 'user', id: bob }, 'Sister of', { kind: 'user', id: carol }, { ...AGENT, assertion: 'inferred' });
    expect(link).toMatchObject({ relation: 'sister of', relationType: 'family', author: 'agent:Claude', source: 'connector', assertion: 'inferred', updatedAt: null });

    // A note written before provenance existed, exactly as the old code wrote it.
    const principal = await graph.privateReviewPrincipal(owner);
    const card = await graph.getPersonOverlay(owner, bob);
    const session = driver.session();
    try {
      const entity = await session.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN r.entityId AS id', { ownerKey: principal.ownerKey, ref: `openchat:user:${bob}` });
      await session.run(`MATCH (e:OverlayEntity {id: $id}) CREATE (:OverlayNote {id: $noteId, ownerKey: $ownerKey, entityId: $id, text: 'legacy note', audience: 'owner', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'})-[:NOTE_ABOUT]->(e)`,
        { id: entity.records[0]!.get('id'), noteId: `legacy-${suffix}`.slice(0, 40), ownerKey: principal.ownerKey });
    } finally { await session.close(); }
    const after = await graph.getPersonOverlay(owner, bob);
    expect(after.notes).toHaveLength(card.notes.length + 1);
    expect(after.notes.find(note => note.text === 'legacy note')).toMatchObject({ author: null, source: null, assertion: null });
    const listed = await graph.listOwnerLinks(owner, 'sister');
    expect(listed.links[0]).toMatchObject({ relationType: 'family', author: 'agent:Claude', from: { kind: 'user', id: bob }, to: { kind: 'user', id: carol } });
  });

  it('edits a relation in place and merges into an identical one', async () => {
    const sister = (await graph.listOwnerLinks(owner, 'sister of')).links[0]!;
    const edited = await graph.updateLink(owner, sister.id, 'Cousin of');
    expect(edited).toMatchObject({ merged: false, link: { id: sister.id, relation: 'cousin of', relationType: 'family', author: 'owner', source: 'app', assertion: 'stated' } });
    expect(edited.link.updatedAt).toBeTruthy();
    const knows = await graph.addLink(owner, { kind: 'user', id: bob }, 'knows', { kind: 'user', id: carol });
    const merged = await graph.updateLink(owner, knows.id, 'cousin of');
    expect(merged).toMatchObject({ merged: true, link: { id: sister.id } });
    expect((await graph.getPersonOverlay(owner, bob)).links.map(value => value.id)).toEqual([sister.id]);
    expect(await status(() => graph.updateLink(other, sister.id, 'enemy of'))).toBe(404);
    expect(await status(() => graph.updateLink(owner, sister.id, ''))).toBe(400);
  });

  it('never merges same-named people; an old openchat:private ref is found again by its request id', async () => {
    const first = await graph.resolvePrivateThing(owner, { kind: 'person', name: 'Alex Rivera' });
    expect((await graph.resolvePrivateThing(owner, { kind: 'person', name: 'alex rivera' })).id).toBe(first.id);
    // As the pre-Noos-semantics OpenChat wrote a separate person: ref openchat:private:<sha256(requestId)[:32]>.
    const principal = await graph.privateReviewPrincipal(owner);
    const oldRef = `openchat:private:${createHash('sha256').update('legacy-alex').digest('hex').slice(0, 32)}`;
    const session = driver.session();
    try {
      await session.run(`CREATE (e:OverlayEntity {id: $id, ownerKey: $ownerKey, kind: 'person', name: 'Alex Rivera', nameKey: 'alex rivera', audience: 'owner', important: false, cadenceMode: 'fixed', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z'})
        CREATE (:OverlayRef {ownerKey: $ownerKey, ref: $ref, entityId: $id})-[:REF_OF]->(e)`, { id: `legacyalex${suffix}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), ownerKey: principal.ownerKey, ref: oldRef });
    } finally { await session.close(); }
    const again = await graph.resolvePrivateThing(owner, { kind: 'person', name: 'Alex Rivera', createNew: true, clientRequestId: 'legacy-alex' });
    expect(again.id).toMatch(/^legacyalex/);
    try { await graph.resolvePrivateThing(owner, { kind: 'person', name: 'Alex Rivera' }); expect.unreachable(); }
    catch (error) {
      expect(error).toBeInstanceOf(graph.PrivateGraphError);
      expect((error as InstanceType<typeof graph.PrivateGraphError>).details).toMatchObject({ code: 'ambiguous_name' });
      expect(((error as InstanceType<typeof graph.PrivateGraphError>).details!.candidates as Array<{ id: string; use: unknown }>).map(value => value.id).sort()).toEqual([first.id, again.id].sort());
    }
  });

  it('searches and reads a neighbourhood, owner-only, leaving blocked people out', async () => {
    const acme = await graph.addLink(owner, { kind: 'user', id: carol }, 'works at', { kind: 'company', name: `Acme ${suffix}` });
    await graph.addLink(owner, { kind: 'thing', id: acme.other.id }, 'works on', { kind: 'project', name: `Atlas ${suffix}` });
    await graph.addLink(owner, { kind: 'user', id: carol }, 'knows', { kind: 'user', id: blocked });
    await graph.addNote(owner, { kind: 'thing', id: acme.other.id }, `Loves climbing ${suffix}`);
    // Blocked after the relation was recorded: reads leave them out from then on.
    const session = driver.session();
    try { await session.run('MATCH (o:User {id: $owner}), (b:User {id: $blocked}) CREATE (o)-[:BLOCKED]->(b)', { owner, blocked }); }
    finally { await session.close(); }

    const byNote = await graph.searchPrivate(owner, { q: `climbing ${suffix}` });
    expect(byNote.things).toEqual([expect.objectContaining({ kind: 'company', id: acme.other.id, matched: ['note'] })]);
    const work = await graph.searchPrivate(owner, { relationType: 'works_at' });
    expect(work.links.map(link => [link.from.id, link.to.id])).toContainEqual([carol, acme.other.id]);
    const people = await graph.searchPrivate(owner, { q: 'pv-' });
    expect(people.things.some(thing => thing.kind === 'user' && thing.id === bob)).toBe(true);
    expect(JSON.stringify(people)).not.toContain(blocked);
    expect((await graph.searchPrivate(other, { q: 'climbing' })).things).toEqual([]);
    expect(await status(() => graph.searchPrivate(owner, {}))).toBe(400);
    expect(await status(() => graph.searchPrivate(owner, { relationType: 'enemy' }))).toBe(400);

    const around = await graph.getNeighbourhood(owner, { kind: 'user', id: carol }, '2');
    expect(around.center).toMatchObject({ kind: 'user', id: carol });
    expect(around.nodes.map(node => node.name).sort()).toEqual(expect.arrayContaining([`Acme ${suffix}`, `Atlas ${suffix}`, bob]));
    expect(JSON.stringify(around)).not.toContain(blocked);
    expect(around.links.every(link => link.from && link.to && link.relationType)).toBe(true);
    expect((await graph.getNeighbourhood(owner, { kind: 'user', id: carol }, undefined)).nodes.map(node => node.name)).not.toContain(`Atlas ${suffix}`);
    // Never creates: someone not written about has an empty neighbourhood, and an Unlinked id is not looked up.
    expect(await graph.getNeighbourhood(other, { kind: 'user', id: carol }, '1')).toMatchObject({ nodes: [], links: [] });
    expect(await graph.getNeighbourhood(owner, { kind: 'unlinked', id: 'nobody-here' }, '1')).toMatchObject({ center: { unlinkedProfileId: 'nobody-here' }, nodes: [], links: [] });
    expect(await status(() => graph.getNeighbourhood(owner, { kind: 'thing', id: acme.other.id }, '3'))).toBe(400);
    expect(await status(() => graph.getNeighbourhood(other, { kind: 'thing', id: acme.other.id }, '1'))).toBe(404);
  });

  // noos-ph2i.2/.3/.6 (Noos 0.3.20), through OpenChat's service.
  it('types relations by what they connect, edits assertions and facts in place, and keeps descriptions and topics', async () => {
    const idea = await graph.resolvePrivateThing(owner, { kind: 'idea', name: `Bloomscroll ${suffix}`, description: 'a feed that nudges you into coherence' });
    expect(idea).toMatchObject({ kind: 'idea', description: 'a feed that nudges you into coherence' });
    // The 2026-10-10 bug: an idea "connected to" a person is not "knows".
    const connected = await graph.addLink(owner, { kind: 'thing', id: idea.id }, 'connected to', { kind: 'user', id: bob }, AGENT);
    expect(connected).toMatchObject({ relationType: 'related', since: null, until: null, context: null, updatedBy: null });
    expect((await graph.addLink(owner, { kind: 'user', id: bob }, 'connected to', { kind: 'user', id: carol })).relationType).toBe('knows');
    const about = await graph.addLink(owner, { kind: 'thing', id: idea.id }, 'is about', { kind: 'topic', name: `Coherence ${suffix}` }, OWNER, { since: '2026', context: 'from the 10-10 call' });
    expect(about).toMatchObject({ relationType: 'about', since: '2026', context: 'from the 10-10 call', other: { kind: 'topic' } });
    expect((await graph.addLink(owner, { kind: 'user', id: bob }, 'odd one', { kind: 'user', id: carol }, OWNER, { relationType: 'other' })).relationType).toBe('related');
    expect(await status(() => graph.addLink(owner, { kind: 'user', id: bob }, 'odd two', { kind: 'user', id: carol }, OWNER, { relationType: 'enemy' }))).toBe(400);
    expect(await status(() => graph.addLink(owner, { kind: 'user', id: bob }, 'odd three', { kind: 'user', id: carol }, OWNER, { since: 'x'.repeat(21) }))).toBe(400);

    // The assertion changes in place: the agent stays the author, the owner is recorded as the editor.
    const flipped = await graph.updateLink(owner, connected.id, { assertion: 'inferred', context: 'Bob suggested it' });
    expect(flipped).toMatchObject({ merged: false, link: { id: connected.id, assertion: 'inferred', author: 'agent:Claude', source: 'connector', updatedBy: 'owner', context: 'Bob suggested it' } });
    expect((await graph.updateLink(owner, connected.id, { context: null, relationType: 'works_on' })).link).toMatchObject({ context: null, relationType: 'works_on' });
    expect(await status(() => graph.updateLink(owner, connected.id, {}))).toBe(400);
    expect(await status(() => graph.updateLink(other, connected.id, { assertion: 'stated' }))).toBe(404);
    const listed = (await graph.listOwnerLinks(owner, `Bloomscroll ${suffix}`)).links.find(link => link.id === about.id);
    expect(listed).toMatchObject({ since: '2026', context: 'from the 10-10 call', updatedBy: null });

    // Descriptions are searchable; an idea graduates to a project; an OpenChat person is not a saved thing.
    const found = await graph.searchPrivate(owner, { q: 'nudges you into' });
    expect(found.things).toEqual([expect.objectContaining({ id: idea.id, description: 'a feed that nudges you into coherence', matched: ['description'] })]);
    const project = await graph.updatePrivateThing(owner, idea.id, { kind: 'project', description: 'feed + nudges' });
    expect(project).toEqual({ id: idea.id, kind: 'project', name: `Bloomscroll ${suffix}`, description: 'feed + nudges' });
    expect((await graph.updatePrivateThing(owner, idea.id, { description: '' })).description).toBeNull();
    expect((await graph.getThing(owner, idea.id)).kind).toBe('project');
    expect(await status(() => graph.updatePrivateThing(owner, idea.id, { kind: 'planet' }))).toBe(400);
    expect(await status(() => graph.updatePrivateThing(owner, idea.id, { ownerKey: 'x' }))).toBe(400);
    expect(await status(() => graph.updatePrivateThing(other, idea.id, { description: 'mine' }))).toBe(404);
    const bobEntity = (await graph.getNeighbourhood(owner, { kind: 'user', id: bob }, '1')).center;
    expect(bobEntity).toMatchObject({ kind: 'user', id: bob });
    expect((await graph.listThings(owner, `Coherence ${suffix}`, 'topic')).things).toEqual([expect.objectContaining({ kind: 'topic', description: null })]);
  });

  it('applied suggestions go through the overlay as source suggestion, assertion inferred', async () => {
    const batch = await review.captureNoteReview(owner, { kind: 'user', id: carol }, { text: 'Carol co-founded Orbit', requestId: `pv-${suffix}` });
    expect(batch.note).toMatchObject({ author: 'owner', source: 'app', assertion: 'stated' });
    batch.status = 'ready';
    batch.suggestions = [{ id: 'link-a', kind: 'connection', text: 'Founded Orbit', relation: 'founded', target: { kind: 'company', name: `Orbit ${suffix}` }, evidence: 'Carol co-founded Orbit' }];
    const principal = await graph.privateReviewPrincipal(owner), session = driver.session();
    try { await session.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload', { id: batch.id, ownerKey: principal.ownerKey, payload: JSON.stringify(batch) }); }
    finally { await session.close(); }
    const applied = await review.applyNoteReview(owner, batch.id, { suggestionIds: ['link-a'] });
    expect(applied.createdRecords).toHaveLength(1);
    const link = (await graph.getPersonOverlay(owner, carol)).links.find(value => value.relation === 'founded');
    expect(link).toMatchObject({ id: applied.createdRecords![0]!.id, relationType: 'works_at', author: 'owner', source: 'suggestion', assertion: 'inferred' });
    await review.undoNoteReview(owner, batch.id);
    expect((await graph.getPersonOverlay(owner, carol)).links.some(value => value.relation === 'founded')).toBe(false);
  });
});
