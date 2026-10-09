import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

// Unlinked is asked only to confirm a profile id the first time it is written.
const unlinked = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/services/unlinkedProvision.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/unlinkedProvision.js')>('../src/services/unlinkedProvision.js');
  return { ...actual, readUnlinkedProfileForIdentity: unlinked.read };
});

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('private people: names, Unlinked profiles and retries', { timeout: 30000 }, () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [dana, alex, other] = ['pp-dana', 'pp-alex', 'pp-other'].map(prefix => `${prefix}-${suffix}`) as [string, string, string];
  const alexName = `Alex ${suffix}`;
  const userIds = [dana, alex, other];
  let driver: Driver;
  let graph: typeof import('../src/services/privateGraph.js');
  const failure = async (run: () => Promise<unknown>) => {
    try { await run(); return { status: 200 }; } catch (error) {
      return error instanceof graph.PrivateGraphError ? { status: error.status, message: error.message, ...error.details } : { status: 500 };
    }
  };

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
      await session.run('MATCH (u:User {id: $alex}) SET u.name = $alexName', { alex, alexName });
      await session.run("MATCH (u:User {id: $dana}) SET u.ideaflowIssuer = 'https://id.ideaflow.app/api/auth', u.ideaflowSub = $sub", { dana, sub: `sub-${suffix}` });
    } finally { await session.close(); }
  });

  beforeEach(() => {
    unlinked.read.mockReset().mockImplementation(async (_identity: unknown, profileId: string) => {
      if (profileId === 'maya-1' || profileId === 'maya-old') return { ok: true, profile: { id: 'maya-1', name: 'Maya Example' } };
      return { ok: false, code: 'not_found' };
    });
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      for (const userId of userIds) await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, userId));
      await session.run('MATCH (u:User) WHERE u.id IN $userIds DETACH DELETE u', { userIds });
    } finally { await session.close(); }
    await driver.close();
    const database = await import('../src/db.js');
    await database.getDriver().close();
  });

  it('never merges two people by a shared name; the caller picks or asks for a new one', async () => {
    // Dana already keeps a card about the OpenChat person called Alex.
    await graph.addNote(dana, { kind: 'user', id: alex }, 'Met at the climbing gym');
    const project = await graph.addLink(dana, { kind: 'user', id: alex }, 'works on', { kind: 'project', name: `Common Ground ${suffix}` });

    const ambiguous = await failure(() => graph.addLink(dana, { kind: 'thing', id: project.other.id }, 'founded by', { kind: 'person', name: alexName }));
    expect(ambiguous).toMatchObject({ status: 409, code: 'ambiguous_name' });
    expect((ambiguous as { candidates: unknown[] }).candidates).toEqual([expect.objectContaining({ kind: 'user', id: alex, use: { toKind: 'user', toId: alex } })]);

    // A deliberately different Alex, kept apart; a retry with the same request id is the same person and link.
    const separate = await graph.addLink(dana, { kind: 'thing', id: project.other.id }, 'founded by', { kind: 'person', name: alexName, createNew: true, clientRequestId: `req-${suffix}` });
    const retried = await graph.addLink(dana, { kind: 'thing', id: project.other.id }, 'founded by', { kind: 'person', name: alexName, createNew: true, clientRequestId: `req-${suffix}` });
    expect(retried.id).toBe(separate.id);
    expect(retried.other.id).toBe(separate.other.id);
    expect(separate.other).toMatchObject({ kind: 'person', name: alexName });

    // Now two Alexes: a bare name is refused with both, and each can be chosen by id.
    const both = await failure(() => graph.addLink(dana, { kind: 'user', id: alex }, 'knows', { kind: 'person', name: alexName }));
    expect((both as { candidates: Array<{ use: unknown }> }).candidates.map(value => value.use)).toEqual(expect.arrayContaining([{ toKind: 'user', toId: alex }, { toKind: 'person', toId: separate.other.id }]));
    const chosen = await graph.addLink(dana, { kind: 'user', id: alex }, 'knows', { kind: 'person', id: separate.other.id });
    expect(chosen.other.id).toBe(separate.other.id);

    // Saving by name follows the same rules.
    expect(await failure(() => graph.resolvePrivateThing(dana, { kind: 'person', name: alexName }))).toMatchObject({ status: 409, code: 'ambiguous_name' });
    const third = await graph.resolvePrivateThing(dana, { kind: 'person', name: alexName, createNew: true, clientRequestId: `req3-${suffix}` });
    expect((await graph.resolvePrivateThing(dana, { kind: 'person', name: alexName, createNew: true, clientRequestId: `req3-${suffix}` })).id).toBe(third.id);
    expect([alex, separate.other.id]).not.toContain(third.id);
    const maya = await graph.resolvePrivateThing(dana, { kind: 'person', name: `Maya ${suffix}` });
    expect((await graph.resolvePrivateThing(dana, { kind: 'person', name: `maya ${suffix}` })).id).toBe(maya.id);
    expect(await failure(() => graph.resolvePrivateThing(dana, { kind: 'unlinked', id: 'maya-1' }))).toMatchObject({ status: 400 });

    // A name only Dana's saved list uses is still reused, so typing it twice is one person.
    const priya = await graph.addLink(dana, { kind: 'user', id: alex }, 'sister of', { kind: 'person', name: `Priya ${suffix}` });
    const priyaAgain = await graph.addLink(dana, { kind: 'user', id: alex }, 'Sister  of', { kind: 'person', name: ` priya ${suffix} ` });
    expect(priyaAgain.id).toBe(priya.id);
  });

  it('records relations and notes about Unlinked profiles under unlinked:person refs, confirmed once', async () => {
    const sister = await graph.addLink(dana, { kind: 'unlinked', id: 'maya-1' }, 'sister of', { kind: 'person', name: `Priya ${suffix}` });
    expect(unlinked.read).toHaveBeenCalledTimes(1);
    expect(unlinked.read.mock.calls[0]![0]).toEqual({ issuer: 'https://id.ideaflow.app/api/auth', subject: `sub-${suffix}` });
    const knows = await graph.addLink(dana, { kind: 'user', id: alex }, 'knows', { kind: 'unlinked', id: 'maya-1' });
    expect(knows.other).toMatchObject({ kind: 'person', name: 'Maya Example', unlinkedProfileId: 'maya-1' });
    // Known now: no further call to Unlinked, and retries return the same note and link.
    const note = await graph.addNote(dana, { kind: 'unlinked', id: 'maya-1' }, 'Working on community spaces');
    const noteAgain = await graph.addNote(dana, { kind: 'unlinked', id: 'maya-1' }, 'Working on community spaces');
    expect(noteAgain.id).toBe(note.id);
    expect((await graph.addLink(dana, { kind: 'user', id: alex }, 'knows', { kind: 'unlinked', id: 'maya-1' })).id).toBe(knows.id);
    expect(unlinked.read).toHaveBeenCalledTimes(1);
    // A merged profile id resolves to the profile it moved to: still one person.
    const moved = await graph.addLink(dana, { kind: 'unlinked', id: 'maya-old' }, 'sister of', { kind: 'person', name: `Priya ${suffix}` });
    expect(moved.id).toBe(sister.id);

    const card = await graph.getUnlinkedPersonOverlay(dana, 'maya-1');
    expect(card).toMatchObject({ profileId: 'maya-1', name: 'Maya Example' });
    expect(card.notes.map(value => value.text)).toEqual(['Working on community spaces']);
    expect(card.links.map(value => [value.relation, value.direction]).sort()).toEqual([['knows', 'in'], ['sister of', 'out']]);
    expect((await graph.getThing(dana, card.thingId!)).unlinkedProfileId).toBe('maya-1');

    const session = driver.session();
    try {
      const refs = await session.run("MATCH (r:OverlayRef {ref: 'unlinked:person:maya-1'})-[:REF_OF]->(e:OverlayEntity) RETURN count(r) AS total, collect(e.id) AS ids");
      expect(refs.records[0]!.get('total').toNumber()).toBe(1);
      expect(refs.records[0]!.get('ids')).toEqual([card.thingId]);
    } finally { await session.close(); }

    // Unknown profiles are refused and nothing is saved; reading never asks Unlinked.
    expect(await failure(() => graph.addNote(dana, { kind: 'unlinked', id: 'nobody' }, 'x'))).toMatchObject({ status: 404 });
    expect(await failure(() => graph.addLink(dana, { kind: 'user', id: alex }, 'knows', { kind: 'unlinked', id: 'bad id!' }))).toMatchObject({ status: 400 });
    expect((await graph.getUnlinkedPersonOverlay(dana, 'nobody')).thingId).toBeNull();
    // Another owner sees nothing of it.
    expect(await graph.getUnlinkedPersonOverlay(other, 'maya-1')).toMatchObject({ thingId: null, notes: [], links: [] });
    expect((await graph.listOwnerLinks(other, '')).links).toEqual([]);
  });

  it('lists the owner’s relations and undoes them', async () => {
    const all = await graph.listOwnerLinks(dana, '');
    expect(all.total).toBe(all.links.length);
    const sisters = await graph.listOwnerLinks(dana, 'sister');
    expect(sisters.links.map(value => [value.from.name, value.to.name])).toEqual(expect.arrayContaining([[alexName, `Priya ${suffix}`], ['Maya Example', `Priya ${suffix}`]]));
    const maya = sisters.links.find(value => value.from.unlinkedProfileId === 'maya-1')!;
    expect(maya.from).toMatchObject({ kind: 'person', unlinkedProfileId: 'maya-1' });
    expect((await graph.listOwnerLinks(dana, 'maya')).links.every(value => [value.from.name, value.to.name].includes('Maya Example'))).toBe(true);

    expect(await graph.deleteLink(dana, maya.id)).toEqual({ deleted: true });
    const card = await graph.getUnlinkedPersonOverlay(dana, 'maya-1');
    expect(card.links.some(value => value.relation === 'sister of')).toBe(false);
    expect(await graph.deleteNote(dana, card.notes[0]!.id)).toEqual({ deleted: true });
    expect((await graph.getUnlinkedPersonOverlay(dana, 'maya-1')).notes).toEqual([]);
    expect(await failure(() => graph.deleteLink(other, card.links[0]!.id))).toMatchObject({ status: 404 });
  });
});
