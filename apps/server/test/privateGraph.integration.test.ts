import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('private graph: one owner, never anyone else', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [alice, bob, carol, blocked, bot, erin] = ['pg-alice', 'pg-bob', 'pg-carol', 'pg-blocked', 'pg-bot', 'pg-erin'].map(prefix => `${prefix}-${suffix}`) as [string, string, string, string, string, string];
  const userIds = [alice, bob, carol, blocked, bot, erin];
  const refOf = (userId: string) => `openchat:user:${userId}`;
  let driver: Driver;
  let graph: typeof import('../src/services/privateGraph.js');
  const status = async (run: () => Promise<unknown>) => { try { await run(); return 200; } catch (error) { return error instanceof graph.PrivateGraphError ? error.status : 500; } };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    graph = await import('../src/services/privateGraph.js');
    await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run(`UNWIND $userIds AS userId CREATE (:User {id: userId, name: userId, email: userId + '@example.test'})`, { userIds });
      await session.run('MATCH (bot:User {id: $bot}) SET bot.isBot = true', { bot });
      await session.run('MATCH (a:User {id: $alice}), (b:User {id: $blocked}) CREATE (b)-[:BLOCKED]->(a)', { alice, blocked });
    } finally { await session.close(); }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      // Erase through the same path account deletion uses, then the fixture people themselves.
      for (const userId of userIds) await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, userId));
      await session.run('MATCH (u:User) WHERE u.id IN $userIds DETACH DELETE u', { userIds });
    } finally { await session.close(); }
    await driver.close();
    const database = await import('../src/db.js');
    await database.getDriver().close();
  });

  it('starts empty and refuses yourself, bots, blocked and unknown people', async () => {
    const empty = await graph.getPersonOverlay(alice, bob);
    expect(empty).toEqual({ userId: bob, person: { id: bob, name: bob, avatarUrl: null }, card: { important: false, cadenceDays: null, cadenceMode: 'fixed', intervalDays: null, lastContactAt: null, nextDueAt: null }, notes: [], links: [] });
    expect(await status(() => graph.getPersonOverlay(alice, alice))).toBe(400);
    for (const target of [bot, blocked, 'no-such-user']) {
      expect(await status(() => graph.getPersonOverlay(alice, target))).toBe(404);
      expect(await status(() => graph.addNote(alice, { kind: 'user', id: target }, 'x'))).toBe(404);
      expect(await status(() => graph.updatePersonCard(alice, target, { important: true }))).toBe(404);
      expect(await status(() => graph.addLink(alice, { kind: 'user', id: bob }, 'knows', { kind: 'user', id: target }))).toBe(404);
    }
  });

  it('keeps notes, importance and cadence per owner', async () => {
    const note = await graph.addNote(alice, { kind: 'user', id: bob }, 'Met at the dinner');
    await graph.addNote(alice, { kind: 'user', id: bob }, 'Second note');
    const edited = await graph.updateNote(alice, note.id, 'Met at the dinner in May');
    expect(edited.text).toBe('Met at the dinner in May');
    const card = await graph.updatePersonCard(alice, bob, { important: true, cadenceDays: 30, cadenceMode: 'expanding' });
    expect(card).toMatchObject({ important: true, cadenceDays: 30, cadenceMode: 'expanding', intervalDays: 30, lastContactAt: null });
    expect(card.nextDueAt).not.toBeNull();
    const first = await graph.updatePersonCard(alice, bob, { contactedNow: true });
    expect(first.intervalDays).toBe(30);
    const second = await graph.updatePersonCard(alice, bob, { contactedNow: true });
    expect(second.intervalDays).toBe(48);
    expect(Date.parse(second.nextDueAt!) - Date.parse(second.lastContactAt!)).toBe(48 * 86400000);

    const mine = await graph.getPersonOverlay(alice, bob);
    expect(mine.notes.map(value => value.text).sort()).toEqual(['Met at the dinner in May', 'Second note']);
    expect(mine.card.important).toBe(true);
    // Carol sees nothing of Alice's, about the same person; Bob sees nothing about himself.
    expect((await graph.getPersonOverlay(carol, bob)).notes).toEqual([]);
    expect((await graph.getPersonOverlay(carol, bob)).card.important).toBe(false);
    expect((await graph.getPersonOverlay(bob, alice)).notes).toEqual([]);
    expect(await status(() => graph.updateNote(carol, note.id, 'hijack'))).toBe(404);
    expect(await status(() => graph.deleteNote(bob, note.id))).toBe(404);
    expect(await graph.deleteNote(alice, note.id)).toEqual({ deleted: true });
    expect((await graph.getPersonOverlay(alice, bob)).notes).toHaveLength(1);
  });

  it('links people to people, companies, ideas and projects, creating each saved item once', async () => {
    const works = await graph.addLink(alice, { kind: 'user', id: bob }, 'Works AT', { kind: 'company', name: 'Acme Robotics' });
    expect(works).toMatchObject({ relation: 'works at', direction: 'out', other: { kind: 'company', name: 'Acme Robotics' } });
    const again = await graph.addLink(alice, { kind: 'user', id: bob }, 'works at', { kind: 'company', name: '  acme   robotics ' });
    expect(again.id).toBe(works.id);
    const idea = await graph.addLink(alice, { kind: 'user', id: bob }, 'interested in', { kind: 'idea', name: 'Open social graph' });
    const knows = await graph.addLink(alice, { kind: 'user', id: bob }, 'knows', { kind: 'user', id: carol });
    expect(knows.other).toMatchObject({ kind: 'user', id: carol });
    await graph.addLink(alice, { kind: 'user', id: carol }, 'interested in', { kind: 'idea', id: idea.other.id });
    await graph.addLink(alice, { kind: 'thing', id: idea.other.id }, 'part of', { kind: 'project', name: 'Atlas' });
    await graph.addNote(alice, { kind: 'thing', id: idea.other.id }, 'Worth a longer write-up');

    const things = await graph.listThings(alice, 'acme', undefined);
    expect(things.things).toEqual([{ id: works.other.id, kind: 'company', name: 'Acme Robotics' }]);
    expect((await graph.listThings(alice, '', 'idea')).things.map(value => value.name)).toEqual(['Open social graph']);
    expect((await graph.listThings(carol, '', undefined)).things).toEqual([]);

    const detail = await graph.getThing(alice, idea.other.id);
    expect(detail.notes.map(value => value.text)).toEqual(['Worth a longer write-up']);
    expect(detail.links.filter(value => value.direction === 'in').map(value => value.other.id).sort()).toEqual([bob, carol].sort());
    expect(detail.links.find(value => value.direction === 'out')?.other).toMatchObject({ kind: 'project', name: 'Atlas' });
    // The same person, seen from the other end of a private "knows".
    expect((await graph.getPersonOverlay(alice, carol)).links.find(value => value.relation === 'knows')).toMatchObject({ direction: 'in', other: { kind: 'user', id: bob } });

    // Another owner cannot read, extend or remove any of it.
    expect(await status(() => graph.getThing(carol, idea.other.id))).toBe(404);
    expect(await status(() => graph.addLink(carol, { kind: 'user', id: bob }, 'likes', { kind: 'idea', id: idea.other.id }))).toBe(404);
    expect(await status(() => graph.addNote(carol, { kind: 'thing', id: idea.other.id }, 'x'))).toBe(404);
    expect(await status(() => graph.deleteLink(carol, knows.id))).toBe(404);
    expect(await status(() => graph.addLink(alice, { kind: 'user', id: bob }, 'works at', { kind: 'idea', id: works.other.id }))).toBe(400);
    expect(await graph.deleteLink(alice, knows.id)).toEqual({ deleted: true });
    expect((await graph.getPersonOverlay(alice, bob)).links.some(value => value.relation === 'knows')).toBe(false);

    // The overlay is a real, traversable part of the graph.
    const session = driver.session();
    try {
      const walk = await session.run('MATCH (:OverlayRef {ref: $ref})-[:REF_OF]->(person:OverlayEntity)-[link:OVERLAY_LINK]->(thing:OverlayEntity) RETURN collect(thing.name) AS names, collect(DISTINCT link.ownerKey = person.ownerKey AND thing.ownerKey = person.ownerKey) AS sameOwner', { ref: refOf(bob) });
      expect((walk.records[0]!.get('names') as string[]).sort()).toEqual(['Acme Robotics', 'Open social graph']);
      expect(walk.records[0]!.get('sameOwner')).toEqual([true]);
      // Nothing is stored under the old OpenChat-only labels.
      const legacy = await session.run('MATCH (n) WHERE n:OpenChatPersonCard OR n:OpenChatPrivateNote OR n:OpenChatThing OR n:OpenChatPrivateLink RETURN count(n) AS total');
      expect(legacy.records[0]!.get('total').toNumber()).toBe(0);
    } finally { await session.close(); }
  });

  it('lists who is due, soonest first, and only for the owner', async () => {
    await graph.updatePersonCard(alice, carol, { cadenceDays: 7 });
    const later = new Date(Date.now() + 400 * 86400000);
    const due = await graph.listDue(alice, later);
    expect(due.due.map(value => value.userId)).toEqual([carol, bob]);
    expect(due.due[1]).toMatchObject({ important: true });
    expect((await graph.listDue(alice, new Date())).due).toEqual([]);
    expect((await graph.listDue(carol, later)).due).toEqual([]);
    await graph.updatePersonCard(alice, carol, { cadenceDays: null });
    expect((await graph.listDue(alice, later)).due.map(value => value.userId)).toEqual([bob]);
  });

  it('follows the owner when they link their Ideaflow sign-in', async () => {
    await graph.addNote(erin, { kind: 'user', id: carol }, 'Written before linking');
    await graph.addLink(erin, { kind: 'user', id: carol }, 'works on', { kind: 'project', name: 'Before linking' });
    const session = driver.session();
    try {
      await session.run("MATCH (u:User {id: $erin}) SET u.ideaflowIssuer = 'https://id.example.test/api/auth', u.ideaflowSub = $sub", { erin, sub: `sub-${suffix}` });
    } finally { await session.close(); }
    const after = await graph.getPersonOverlay(erin, carol);
    expect(after.notes.map(value => value.text)).toEqual(['Written before linking']);
    expect(after.links.map(value => value.other.name)).toEqual(['Before linking']);
    // Still only hers.
    expect((await graph.getPersonOverlay(alice, carol)).notes.map(value => value.text)).not.toContain('Written before linking');
    await graph.addNote(erin, { kind: 'user', id: carol }, 'Written after linking');
    expect((await graph.getPersonOverlay(erin, carol)).notes).toHaveLength(2);
  });

  it('exports the owner’s graph and removes both sides on account deletion', async () => {
    const exported = await graph.exportPrivateGraph(alice) as { entities: Array<{ name: string; refs: string[] }>; notes: unknown[]; links: unknown[] };
    // Bob and Carol as people, plus the company, idea and project.
    expect(exported.entities).toHaveLength(5);
    expect(exported.entities.flatMap(value => value.refs).sort()).toEqual([refOf(bob), refOf(carol)].sort());
    expect(exported.notes).toHaveLength(2);
    expect((await graph.exportPrivateGraph(carol)).notes).toEqual([]);

    await graph.addNote(carol, { kind: 'user', id: bob }, 'Carol about Bob');
    await graph.addLink(carol, { kind: 'user', id: alice }, 'knows', { kind: 'user', id: bob });
    const session = driver.session();
    try {
      // Bob leaves: nobody keeps an overlay pointing at him, and what he kept is gone.
      await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, bob));
      const left = await session.run('OPTIONAL MATCH (r:OverlayRef {ref: $ref}) WITH count(r) AS refs OPTIONAL MATCH (n:OverlayNote {text: $text}) RETURN refs, count(n) AS notes', { ref: refOf(bob), text: 'Carol about Bob' });
      expect([left.records[0]!.get('refs').toNumber(), left.records[0]!.get('notes').toNumber()]).toEqual([0, 0]);
      expect((await graph.getPersonOverlay(alice, bob)).notes).toEqual([]);
      expect((await graph.getPersonOverlay(carol, alice)).links).toEqual([]);
      expect((await graph.exportPrivateGraph(alice) as { entities: unknown[] }).entities).toHaveLength(4);

      // Alice leaves: everything she kept is gone, under either identity that could name her.
      await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, alice));
      expect(await graph.exportPrivateGraph(alice)).toEqual({ entities: [], notes: [], links: [], noteReviews: [], privateAsks: [] });
      await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, erin));
      expect(await graph.exportPrivateGraph(erin)).toEqual({ entities: [], notes: [], links: [], noteReviews: [], privateAsks: [] });
      // Carol's own overlay is untouched by other people leaving, apart from what pointed at them.
      expect((await graph.exportPrivateGraph(carol) as { entities: unknown[] }).entities).toHaveLength(0);
    } finally { await session.close(); }
  });
});
