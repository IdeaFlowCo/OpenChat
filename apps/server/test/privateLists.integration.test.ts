import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

// Private lists are the Noos overlay's `list` kind (Noos #105): owner-private
// collections whose members are outgoing `contains` links to people.
integration('private lists: owner-only editing of list membership', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [alice, bob, carol, blocked] = ['list-alice', 'list-bob', 'list-carol', 'list-blocked'].map(prefix => `${prefix}-${suffix}`) as [string, string, string, string];
  const userIds = [alice, bob, carol, blocked];
  let driver: Driver;
  let graph: typeof import('../src/services/privateGraph.js');
  const status = async (run: () => Promise<unknown>) => { try { await run(); return 200; } catch (error) { return error instanceof graph.PrivateGraphError ? error.status : 500; } };

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!; process.env.NEO4J_USER = user!; process.env.NEO4J_PASSWORD = password!;
    graph = await import('../src/services/privateGraph.js');
    await graph.ensurePrivateGraphIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try { await session.run('UNWIND $userIds AS userId CREATE (:User {id: userId, name: userId})', { userIds }); } finally { await session.close(); }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      for (const userId of userIds) await session.executeWrite(tx => graph.deletePrivateGraphForUser(tx, userId));
      await session.run('MATCH (u:User) WHERE u.id IN $userIds DETACH DELETE u', { userIds });
    } finally { await session.close(); }
    await driver.close();
    await (await import('../src/db.js')).getDriver().close();
  });

  let listId = '';
  it('saves a list like any named thing, and keeps it a list', async () => {
    const list = await graph.createPrivateThing(alice, 'list', `Seed investors ${suffix}`, 'people to contact for the seed round');
    expect([list.kind, list.description]).toEqual(['list', 'people to contact for the seed round']);
    listId = list.id;
    expect((await graph.listThings(alice, '', 'list')).things.map(thing => thing.id)).toEqual([listId]);
    expect((await graph.resolvePrivateThing(alice, { kind: 'list', name: `Seed investors ${suffix}` })).id).toBe(listId);
    expect((await graph.updatePrivateThing(alice, listId, { name: `Seed investors (2026) ${suffix}` })).name).toBe(`Seed investors (2026) ${suffix}`);
    expect(await status(() => graph.updatePrivateThing(alice, listId, { kind: 'project' }))).toBe(409);
    const idea = await graph.createPrivateThing(alice, 'idea', `An idea ${suffix}`);
    expect(await status(() => graph.updatePrivateThing(alice, idea.id, { kind: 'list' }))).toBe(409);
  });

  it('adds OpenChat people and saved people, once each, and pages through them', async () => {
    const byUser = await graph.addListMember(alice, listId, { kind: 'user', id: bob }, { author: 'agent:Test', source: 'connector', assertion: 'stated' });
    expect([byUser.member.kind, byUser.member.id, byUser.author, byUser.source]).toEqual(['user', bob, 'agent:Test', 'connector']);
    const again = await graph.addListMember(alice, listId, { kind: 'user', id: bob });
    expect(again.linkId).toBe(byUser.linkId);
    const names = ['Ada', 'Ben', 'Cy', 'Dee'].map(name => `${name} ${suffix}`);
    for (const name of names) await graph.addListMember(alice, listId, { kind: 'person', name });
    const saved = await graph.resolvePrivateThing(alice, { kind: 'person', name: names[0]! });
    expect((await graph.addListMember(alice, listId, { kind: 'person', id: saved.id })).member.id).toBe(saved.id);
    // A list note or another link on the list is not a member.
    await graph.addNote(alice, { kind: 'thing', id: listId }, 'Ask warm intros first');
    await graph.addLink(alice, { kind: 'thing', id: listId }, 'for', { kind: 'project', name: `Fundraise ${suffix}` });

    const seen: string[] = [];
    let after: string | undefined, pages = 0;
    do {
      const page = await graph.listMembers(alice, listId, { after, limit: '2' });
      seen.push(...page.members.map(member => member.member.name));
      after = page.nextCursor ?? undefined;
      pages++;
    } while (after && pages < 10);
    expect(seen.sort()).toEqual([bob, ...names].sort());
    expect(pages).toBeGreaterThan(2);
    expect(await status(() => graph.listMembers(alice, listId, { after: 'not-a-cursor' }))).toBe(400);
  });

  it('only people can be members, and only of the owner’s own lists', async () => {
    expect(await status(() => graph.addListMember(alice, listId, { kind: 'company', name: `Acme ${suffix}` }))).toBe(400);
    expect(await status(() => graph.addListMember(alice, listId, { kind: 'user', id: alice }))).toBe(400);
    const idea = (await graph.listThings(alice, `An idea ${suffix}`, 'idea')).things[0]!;
    expect(await status(() => graph.listMembers(alice, idea.id))).toBe(404);
    expect(await status(() => graph.addListMember(alice, idea.id, { kind: 'user', id: bob }))).toBe(404);
    // Carol sees nothing of Alice's list, and cannot add to or remove from it.
    expect(await status(() => graph.listMembers(carol, listId))).toBe(404);
    expect(await status(() => graph.addListMember(carol, listId, { kind: 'user', id: bob }))).toBe(404);
    const [first] = (await graph.listMembers(alice, listId)).members;
    expect(await status(() => graph.removeListMember(carol, listId, first!.linkId))).toBe(404);
    // Bob, who is on the list, learns nothing either.
    expect((await graph.listThings(bob, '', 'list')).things).toEqual([]);
  });

  it('removes a membership only, hides blocked people, and a cursor from another list is refused', async () => {
    const member = await graph.addListMember(alice, listId, { kind: 'user', id: blocked });
    const session = driver.session();
    try { await session.run('MATCH (a:User {id: $alice}), (b:User {id: $blocked}) CREATE (b)-[:BLOCKED]->(a)', { alice, blocked }); } finally { await session.close(); }
    expect((await graph.listMembers(alice, listId)).members.some(entry => entry.linkId === member.linkId)).toBe(false);

    const { members } = await graph.listMembers(alice, listId);
    const target = members.find(entry => entry.member.kind === 'person')!;
    expect(await graph.removeListMember(alice, listId, target.linkId)).toEqual({ removed: true, linkId: target.linkId });
    expect((await graph.listMembers(alice, listId)).members.some(entry => entry.linkId === target.linkId)).toBe(false);
    expect((await graph.getThing(alice, target.member.id)).id).toBe(target.member.id);
    expect(await status(() => graph.removeListMember(alice, listId, target.linkId))).toBe(404);
    // A non-membership link on the list is not removable as a member.
    const other = (await graph.getThing(alice, listId)).links.find(link => link.relation === 'for')!;
    expect(await status(() => graph.removeListMember(alice, listId, other.id))).toBe(404);

    const second = await graph.createPrivateThing(alice, 'list', `Angels ${suffix}`);
    for (const name of ['Eve', 'Fay', 'Gus']) await graph.addListMember(alice, second.id, { kind: 'person', name: `${name} ${suffix}` });
    const page = await graph.listMembers(alice, second.id, { limit: '1' });
    expect(page.nextCursor).not.toBeNull();
    expect(await status(() => graph.listMembers(alice, listId, { after: page.nextCursor! }))).toBe(400);
    // Deleting a list keeps its members' own cards.
    await graph.deletePrivateThing(alice, second.id);
    expect((await graph.listThings(alice, `Eve ${suffix}`, 'person')).things).toHaveLength(1);
  });
});
