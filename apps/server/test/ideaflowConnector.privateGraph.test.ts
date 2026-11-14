import { createHash, createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: state.run, close: async () => {} }) }) }));
const graph = vi.hoisted(() => ({
  importContactSources: vi.fn(), savePeopleState: vi.fn(), mergePeople: vi.fn(), splitPerson: vi.fn(), revertMerge: vi.fn(), listMergeEvents: vi.fn(),
  addLink: vi.fn(), addNote: vi.fn(), deleteLink: vi.fn(), deleteNote: vi.fn(), deletePrivateThing: vi.fn(), getPersonOverlay: vi.fn(), getThing: vi.fn(),
  updateNote: vi.fn(), listNoteRevisions: vi.fn(), setPersonField: vi.fn(), markPersonField: vi.fn(), revealPersonField: vi.fn(), personFields: vi.fn(),
  getUnlinkedPersonOverlay: vi.fn(), listDue: vi.fn(), resolvePrivateThing: vi.fn(), listOwnerLinks: vi.fn(), listThings: vi.fn(), updatePersonCard: vi.fn(),
  updateLink: vi.fn(), searchPrivate: vi.fn(), getNeighbourhood: vi.fn(), updatePrivateThing: vi.fn(),
  saveAsk: vi.fn(), listMembers: vi.fn(), addListMember: vi.fn(), removeListMember: vi.fn(), listAsks: vi.fn(), getAsk: vi.fn(), updateAsk: vi.fn(), deleteAsk: vi.fn(),
}));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, ...graph };
});
import { handleIdeaflowConnector, connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import privateGraphRoutes, { privateGraphBody } from '../src/routes/privateGraph.js';
import { PrivateGraphError } from '../src/services/privateGraph.js';

const secret = 'test-only-connector-secret-32-bytes-minimum';
function sign(body: string, scope: string, client?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://chat.ideaflow.app/mcp', identity_issuer: 'https://id.ideaflow.app/api/auth', sub: 'subject', actor_id:'ideaflow-grant:synthetic', scope, iat: now, exp: now + 60, jti: randomUUID(), body_sha256: createHash('sha256').update(body).digest('hex'), ...(client !== undefined ? { client } : {}) })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
const PRIVATE_READS = ['oc_get_person_private', 'oc_get_unlinked_person_private', 'oc_list_private_links', 'oc_search_private', 'oc_get_neighbourhood', 'oc_list_private_things', 'oc_get_private_thing', 'oc_list_catch_up', 'oc_list_note_revisions', 'oc_get_person_field'];
const PRIVATE_WRITES = ['oc_set_person_private', 'oc_add_private_note', 'oc_delete_private_note', 'oc_add_private_link', 'oc_update_private_link', 'oc_delete_private_link', 'oc_save_private_thing', 'oc_update_private_thing', 'oc_delete_private_thing', 'oc_update_private_note', 'oc_set_person_field', 'oc_mark_person_field'];
const CONNECTOR = { author: 'agent:Ideaflow connector', source: 'connector', assertion: 'stated' };

describe('private people knowledge through the shared Ideaflow connector', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    const app = express();
    app.post('/api/connector/mcp', express.raw({ type: 'application/json', limit: '7mb' }), handleIdeaflowConnector);
    app.use(privateGraphBody);
    app.use(express.json()); app.use('/api', connectorOperationGuard);
    app.use('/api/private', privateGraphRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { delete process.env.IDEAFLOW_CONNECTOR_SECRET; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => {
    process.env.IDEAFLOW_CONNECTOR_SECRET = secret;
    for (const mock of Object.values(graph)) mock.mockReset();
    state.run.mockReset().mockImplementation(async (query: string) => query.includes('ideaflowIssuer:$issuer') ? { records: [{ get: () => 'owner' }] } : { records: [] });
  });
  async function call(method: string, params: unknown, scope = 'openchat:read openchat:write', client?: unknown) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return fetch(`${base}/api/connector/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sign(body, scope, client)}` }, body });
  }
  const tool = async (name: string, args: Record<string, unknown>, scope?: string, client?: unknown) => (await call('tools/call', { name, arguments: args }, scope, client)).json() as Promise<any>;

  it('delivers full source batches and large state through body-bound REST delegation', async () => {
    const cards = Array.from({length:25}, (_, index) => ({source:'synthetic:book',sourceId:String(index),name:'Synthetic',data:{schemaVersion:1,note:'x'.repeat(260000)}}));
    graph.importContactSources.mockResolvedValue({results:[{index:0,id:'saved'}]});
    const imported = await tool('oc_import_contact_sources',{cards});
    expect(imported.result.isError).toBeUndefined();
    expect(graph.importContactSources).toHaveBeenCalledWith('owner',cards,CONNECTOR,'ideaflow-grant:synthetic');
    graph.savePeopleState.mockResolvedValue({revision:1});
    const state = {operationId:'large-state',expectedRevision:0,payload:cards[0].data};
    const saved = await tool('oc_save_people_state',{thingId:'saved',...state});
    expect(saved.result.isError).toBeUndefined();
    expect(graph.savePeopleState).toHaveBeenCalledWith('owner','saved',state,CONNECTOR,'ideaflow-grant:synthetic');
  });

  it('routes people merges, splits, undo and history with the verified agent identity', async () => {
    const merges = [{ids:['entity-aaaa1','entity-bbbb2'],rule:'same-underlying-contact',evidence:['carddav:a:b'],operationId:'op-1'}];
    graph.mergePeople.mockResolvedValue({results:[{index:0,merged:true,headId:'entity-aaaa1'}]});
    const merged = await tool('oc_merge_people',{merges,batchId:'resolver-1'});
    expect(merged.result.isError).toBeUndefined();
    expect(graph.mergePeople).toHaveBeenCalledWith('owner',merges,'resolver-1',CONNECTOR,'ideaflow-grant:synthetic');
    graph.splitPerson.mockResolvedValue({id:'entity-bbbb2'});
    await tool('oc_split_person',{thingId:'entity-bbbb2',operationId:'split-1'});
    expect(graph.splitPerson).toHaveBeenCalledWith('owner',{id:'entity-bbbb2',operationId:'split-1'},CONNECTOR,'ideaflow-grant:synthetic');
    graph.revertMerge.mockResolvedValue({reverted:['e1'],skipped:[]});
    await tool('oc_revert_merge',{batchId:'resolver-1'});
    expect(graph.revertMerge).toHaveBeenCalledWith('owner',{batchId:'resolver-1'},CONNECTOR,'ideaflow-grant:synthetic');
    graph.listMergeEvents.mockResolvedValue({events:[],truncated:false});
    const listed = await tool('oc_list_merge_events',{thingId:'entity-aaaa1'},'openchat:read');
    expect(listed.result.isError).toBeUndefined();
    expect(graph.listMergeEvents).toHaveBeenCalledWith('owner',expect.objectContaining({entityId:'entity-aaaa1'}));
    // Identity changes are writes: a read-only grant cannot merge.
    expect((await call('tools/call',{name:'oc_merge_people',arguments:{merges}},'openchat:read')).status).toBe(403);
  });

  it('lists private reads under openchat:read and writes under openchat:write, described as owner-private', async () => {
    const read = (await (await call('tools/list', {}, 'openchat:read')).json() as any).result.tools;
    const names = read.map((value: any) => value.name);
    expect(names).toEqual(expect.arrayContaining(PRIVATE_READS));
    expect(names.some((name: string) => PRIVATE_WRITES.includes(name))).toBe(false);
    const all = (await (await call('tools/list', {})).json() as any).result.tools;
    for (const name of [...PRIVATE_READS, ...PRIVATE_WRITES]) {
      const entry = all.find((value: any) => value.name === name);
      expect(entry, name).toBeDefined();
      expect(entry.annotations.readOnlyHint).toBe(PRIVATE_READS.includes(name));
      expect(entry.securitySchemes[0].scopes).toEqual([PRIVATE_READS.includes(name) ? 'openchat:read' : 'openchat:write']);
      expect(entry.description).toMatch(/visible only to the owner/);
      expect(entry.description).toMatch(/shown in OpenChat and on the owner's Unlinked person and contact pages/);
      expect(entry.description).not.toMatch(/OpenChat and Unlinked/);
    }
    for (const name of ['oc_search_private', 'oc_get_neighbourhood', 'oc_get_person_private', 'oc_list_private_links', 'oc_get_private_thing']) {
      expect(all.find((value: any) => value.name === name).description, name).toMatch(/author .*source .*assertion/);
    }
    const search = all.find((value: any) => value.name === 'oc_search_private');
    expect(search.inputSchema.properties.relationType.enum).toEqual(['knows', 'family', 'worked_with', 'works_at', 'works_on', 'attended', 'interested_in', 'part_of', 'about', 'asks', 'related']);
    expect(search.inputSchema.properties.kind.enum).toEqual(['person', 'company', 'idea', 'project', 'topic', 'list']);
    const add = all.find((value: any) => value.name === 'oc_add_private_link');
    expect(Object.keys(add.inputSchema.properties)).toEqual(expect.arrayContaining(['relationType', 'since', 'until', 'context']));
    expect(add.inputSchema.properties.toKind.enum).toContain('topic');
    const update = all.find((value: any) => value.name === 'oc_update_private_link');
    expect(update.inputSchema.required).toEqual(['linkId']);
    expect(Object.keys(update.inputSchema.properties)).toEqual(expect.arrayContaining(['relation', 'assertion', 'relationType', 'since', 'until', 'context']));
    expect(all.find((value: any) => value.name === 'oc_save_private_thing').inputSchema.properties.description.maxLength).toBe(280);
    expect(all.find((value: any) => value.name === 'oc_update_private_thing').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(all.find((value: any) => value.name === 'oc_update_private_link').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(all.find((value: any) => value.name === 'oc_delete_private_link').annotations.destructiveHint).toBe(true);
    const remove = all.find((value: any) => value.name === 'oc_delete_private_thing');
    expect(remove.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(remove.description).toMatch(/undo for oc_save_private_thing/);
    expect(remove.description).toMatch(/private notes and every private relation/);
    expect(all.find((value: any) => value.name === 'oc_save_private_thing').annotations.destructiveHint).toBe(false);
  });

  it('ask tools: owner-only, mapped onto the ask routes with the connector as author', async () => {
    const read = (await (await call('tools/list', {}, 'openchat:read')).json() as any).result.tools.map((value: any) => value.name);
    expect(read).toContain('oc_list_asks');
    expect(read.some((name: string) => ['oc_save_ask', 'oc_update_ask', 'oc_delete_ask'].includes(name))).toBe(false);
    const all = (await (await call('tools/list', {})).json() as any).result.tools;
    for (const name of ['oc_save_ask', 'oc_list_asks', 'oc_update_ask', 'oc_delete_ask']) {
      const entry = all.find((value: any) => value.name === name);
      expect(entry, name).toBeDefined();
      expect(entry.description).toMatch(/only the owner ever sees them/);
      expect(entry.description).toMatch(/nothing is shown to anyone else/);
    }
    expect(all.find((value: any) => value.name === 'oc_delete_ask').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(all.find((value: any) => value.name === 'oc_list_asks').annotations.readOnlyHint).toBe(true);
    expect(all.find((value: any) => value.name === 'oc_save_ask').inputSchema.required).toEqual(['text']);
    expect(all.find((value: any) => value.name === 'oc_list_asks').inputSchema.properties.direction.enum).toEqual(['from_me', 'for_me', 'from_others']);

    graph.saveAsk.mockResolvedValue({ ask: { id: 'ask-1' }, created: true });
    const saved = await tool('oc_save_ask', { authorKind: 'thing', authorId: 'thing-1', text: 'SF chiropractor for neck pain', horizon: 'short', evidenceLabel: 'Facebook post', evidenceSeenAt: '2026-10-29', assertion: 'inferred' }, undefined, 'Friends asks monitor');
    expect(JSON.parse(saved.result.content[0].text)).toEqual({ ask: { id: 'ask-1' }, created: true });
    expect(graph.saveAsk).toHaveBeenCalledWith('owner', { author: { kind: 'thing', id: 'thing-1' }, text: 'SF chiropractor for neck pain', horizon: 'short', assertion: 'inferred',
      evidence: { label: 'Facebook post', seenAt: '2026-10-29' } }, { author: 'agent:Friends asks monitor', source: 'connector', assertion: 'inferred' });
    await tool('oc_save_ask', { authorKind: 'self', text: 'Heal my TFCC', horizon: 'evergreen' });
    expect(graph.saveAsk).toHaveBeenLastCalledWith('owner', { author: 'self', text: 'Heal my TFCC', horizon: 'evergreen' }, CONNECTOR);
    // Who cares, who carries and where it was placed travel as separate facts.
    await tool('oc_save_ask', { authorKind: 'user', authorId: 'bo', carrierKind: 'self', placements: ['self', 'conversation:c7', 'thing:board-1'], text: 'Intro to a sound engineer' });
    expect(graph.saveAsk).toHaveBeenLastCalledWith('owner', { author: { kind: 'user', id: 'bo' }, carrier: 'self', placements: ['self', { kind: 'conversation', id: 'c7' }, { kind: 'thing', id: 'board-1' }], text: 'Intro to a sound engineer' }, CONNECTOR);
    expect((await call('tools/call', { name: 'oc_save_ask', arguments: { authorKind: 'self', text: 'x', exposure: 'everyone' } })).status).toBe(400);
    await tool('oc_save_ask', { askerKind: 'self', text: 'legacy own ask' });
    expect(graph.saveAsk).toHaveBeenLastCalledWith('owner', { asker: 'self', text: 'legacy own ask' }, CONNECTOR);
    await tool('oc_save_ask', { askerKind: 'user', askerId: 'legacy-bob', text: 'legacy person ask' });
    expect(graph.saveAsk).toHaveBeenLastCalledWith('owner', { asker: { kind: 'user', id: 'legacy-bob' }, text: 'legacy person ask' }, CONNECTOR);
    expect((await call('tools/call', { name: 'oc_save_ask', arguments: { authorKind: 'self', text: 'x' } }, 'openchat:read')).status).toBe(403);

    graph.listAsks.mockResolvedValue({ asks: [], truncated: false });
    await tool('oc_list_asks', { direction: 'for_me', status: 'all', query: 'chiro', needsRecheck: true }, 'openchat:read');
    expect(graph.listAsks).toHaveBeenCalledWith('owner', { direction: 'for_me', status: 'all', q: 'chiro', needsRecheck: 'true' });
    await tool('oc_list_asks', { aboutKind: 'user', aboutId: 'bob' }, 'openchat:read');
    expect(graph.listAsks).toHaveBeenLastCalledWith('owner', { aboutKind: 'user', aboutId: 'bob' });
    await tool('oc_list_asks', { askerKind: 'user', askerId: 'legacy-bob' }, 'openchat:read');
    expect(graph.listAsks).toHaveBeenLastCalledWith('owner', { askerKind: 'user', askerId: 'legacy-bob' });
    await tool('oc_list_asks', { asker: 'self' }, 'openchat:read');
    expect(graph.listAsks).toHaveBeenLastCalledWith('owner', { asker: 'self' });
    expect((await call('tools/call', { name: 'oc_list_asks', arguments: { direction: 'to_me' } }, 'openchat:read')).status).toBe(400);

    graph.updateAsk.mockResolvedValue({ id: 'ask-1', status: 'fulfilled' });
    await tool('oc_update_ask', { askId: 'ask-1', status: 'fulfilled', recheckedNow: true });
    expect(graph.updateAsk).toHaveBeenCalledWith('owner', 'ask-1', { status: 'fulfilled', recheckedNow: true }, CONNECTOR);
    await tool('oc_update_ask', { askId: 'ask-1', clearEvidence: true, evidenceLabel: 'ignored' });
    expect(graph.updateAsk).toHaveBeenLastCalledWith('owner', 'ask-1', { evidence: null }, CONNECTOR);
    await tool('oc_update_ask', { askId: 'ask-1', exposure: 'this_chat', exposureConversationId: 'conv-1' });
    expect(graph.updateAsk).toHaveBeenLastCalledWith('owner', 'ask-1', { exposure: 'this_chat', exposureConversationId: 'conv-1' }, CONNECTOR);
    await tool('oc_update_ask', { askId: 'ask-1', carrierKind: 'user', carrierId: 'alice', placements: [] });
    expect(graph.updateAsk).toHaveBeenLastCalledWith('owner', 'ask-1', { carrier: { kind: 'user', id: 'alice' }, placements: [] }, CONNECTOR);
    await tool('oc_update_ask', { askId: 'ask-1', clearCarrier: true });
    expect(graph.updateAsk).toHaveBeenLastCalledWith('owner', 'ask-1', { carrier: null }, CONNECTOR);

    graph.deleteAsk.mockResolvedValue({ deleted: true, id: 'ask-1' });
    await tool('oc_delete_ask', { askId: 'ask-1' });
    expect(graph.deleteAsk).toHaveBeenCalledWith('owner', 'ask-1');
    graph.getAsk.mockRejectedValue(new PrivateGraphError(404, 'Not found'));
    graph.updateAsk.mockRejectedValue(new PrivateGraphError(404, 'Not found'));
    const missing = await tool('oc_update_ask', { askId: 'someone-elses', status: 'withdrawn' });
    expect(missing.result.isError).toBe(true);
  });

  it('list tools: members read under openchat:read, edits under openchat:write, mapped onto the list routes', async () => {
    const read = (await (await call('tools/list', {}, 'openchat:read')).json() as any).result.tools.map((value: any) => value.name);
    expect(read).toContain('oc_list_members');
    expect(read.some((name: string) => ['oc_add_list_member', 'oc_remove_list_member'].includes(name))).toBe(false);
    const all = (await (await call('tools/list', {})).json() as any).result.tools;
    expect(all.find((value: any) => value.name === 'oc_remove_list_member').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(all.find((value: any) => value.name === 'oc_save_private_thing').inputSchema.properties.kind.enum).toContain('list');
    graph.listMembers.mockResolvedValue({ list: { id: 'list-1' }, members: [], nextCursor: null });
    await tool('oc_list_members', { listId: 'list-1', after: 'cursor-1', limit: 50 }, 'openchat:read');
    expect(graph.listMembers).toHaveBeenCalledWith('owner', 'list-1', { after: 'cursor-1', limit: '50' });
    graph.addListMember.mockResolvedValue({ linkId: 'l1' });
    await tool('oc_add_list_member', { listId: 'list-1', memberKind: 'unlinked', memberId: 'https://linkedin.com/in/x' }, undefined, 'Investor import');
    expect(graph.addListMember).toHaveBeenCalledWith('owner', 'list-1', { kind: 'unlinked', id: 'https://linkedin.com/in/x' }, { author: 'agent:Investor import', source: 'connector', assertion: 'stated' });
    await tool('oc_add_list_member', { listId: 'list-1', memberKind: 'person', memberName: 'Maya', createNew: true, clientRequestId: 'r1' });
    expect(graph.addListMember).toHaveBeenLastCalledWith('owner', 'list-1', { kind: 'person', name: 'Maya', createNew: true, clientRequestId: 'r1' }, CONNECTOR);
    expect((await call('tools/call', { name: 'oc_add_list_member', arguments: { listId: 'list-1', memberKind: 'company', memberId: 'c1' } })).status).toBe(400);
    expect((await call('tools/call', { name: 'oc_add_list_member', arguments: { listId: 'list-1', memberKind: 'user', memberId: 'u1' } }, 'openchat:read')).status).toBe(403);
    graph.removeListMember.mockResolvedValue({ removed: true, linkId: 'l1' });
    await tool('oc_remove_list_member', { listId: 'list-1', linkId: 'l1' });
    expect(graph.removeListMember).toHaveBeenCalledWith('owner', 'list-1', 'l1');
  });

  it('dispatches reads and writes to the private routes as the linked owner', async () => {
    graph.getUnlinkedPersonOverlay.mockResolvedValue({ profileId: 'maya-1', thingId: null, notes: [], links: [] });
    const read = await tool('oc_get_unlinked_person_private', { profileId: 'maya-1' }, 'openchat:read');
    expect(read.result.isError).toBeUndefined();
    expect(graph.getUnlinkedPersonOverlay).toHaveBeenCalledWith('owner', 'maya-1');

    graph.listOwnerLinks.mockResolvedValue({ links: [], total: 0 });
    await tool('oc_list_private_links', { query: 'sister of' }, 'openchat:read');
    expect(graph.listOwnerLinks).toHaveBeenCalledWith('owner', 'sister of');

    graph.addLink.mockResolvedValue({ id: 'link-1' });
    const link = await tool('oc_add_private_link', { subjectKind: 'unlinked', subjectId: 'maya-1', relation: 'sister of', toKind: 'person', toName: 'Priya', createNew: true, clientRequestId: 'req-1' });
    expect(JSON.parse(link.result.content[0].text)).toEqual({ id: 'link-1' });
    expect(graph.addLink).toHaveBeenCalledWith('owner', { kind: 'unlinked', id: 'maya-1' }, 'sister of', { kind: 'person', name: 'Priya', createNew: true, clientRequestId: 'req-1' }, CONNECTOR, {});

    graph.addNote.mockResolvedValue({ id: 'note-1' });
    await tool('oc_add_private_note', { subjectKind: 'user', subjectId: 'bob', text: 'Met at dinner' });
    expect(graph.addNote).toHaveBeenCalledWith('owner', { kind: 'user', id: 'bob' }, 'Met at dinner', CONNECTOR);

    graph.updatePersonCard.mockResolvedValue({ important: true });
    await tool('oc_set_person_private', { userId: 'bob', important: true, cadenceDays: null });
    expect(graph.updatePersonCard).toHaveBeenCalledWith('owner', 'bob', { important: true, cadenceDays: null }, CONNECTOR,'ideaflow-grant:synthetic');

    graph.resolvePrivateThing.mockResolvedValue({ id: 'thing-1', kind: 'person', name: 'Maya' });
    const saved = await tool('oc_save_private_thing', { kind: 'person', name: 'Maya', createNew: true, clientRequestId: 'req-2' });
    expect(JSON.parse(saved.result.content[0].text)).toEqual({ id: 'thing-1', kind: 'person', name: 'Maya' });
    expect(graph.resolvePrivateThing).toHaveBeenCalledWith('owner', { kind: 'person', name: 'Maya', createNew: true, clientRequestId: 'req-2' });

    graph.addLink.mockResolvedValue({ id: 'link-3' });
    await tool('oc_add_private_link', { subjectKind: 'thing', subjectId: 'idea-1', relation: 'connected to', toKind: 'topic', toName: 'Coherence', relationType: 'about', since: '2026', context: 'from the call' });
    expect(graph.addLink).toHaveBeenLastCalledWith('owner', { kind: 'thing', id: 'idea-1' }, 'connected to', { kind: 'topic', name: 'Coherence' }, CONNECTOR, { relationType: 'about', since: '2026', context: 'from the call' });

    graph.resolvePrivateThing.mockResolvedValue({ id: 'thing-2', kind: 'idea', name: 'Bloomscroll', description: 'a feed that nudges you into coherence' });
    await tool('oc_save_private_thing', { kind: 'idea', name: 'Bloomscroll', description: 'a feed that nudges you into coherence' });
    expect(graph.resolvePrivateThing).toHaveBeenLastCalledWith('owner', { kind: 'idea', name: 'Bloomscroll', description: 'a feed that nudges you into coherence' });

    graph.updatePrivateThing.mockResolvedValue({ id: 'thing-2', kind: 'project', name: 'Bloomscroll', description: null });
    const updated = await tool('oc_update_private_thing', { thingId: 'thing-2', kind: 'project', description: '' });
    expect(JSON.parse(updated.result.content[0].text)).toEqual({ id: 'thing-2', kind: 'project', name: 'Bloomscroll', description: null });
    expect(graph.updatePrivateThing).toHaveBeenCalledWith('owner', 'thing-2', { kind: 'project', description: '' });
    expect((await call('tools/call', { name: 'oc_update_private_thing', arguments: { thingId: 'thing-2', kind: 'planet' } })).status).toBe(400);
    expect((await call('tools/call', { name: 'oc_update_private_thing', arguments: { thingId: 'thing-2', name: 'x' } }, 'openchat:read')).status).toBe(403);

    graph.deleteLink.mockResolvedValue({ deleted: true });
    await tool('oc_delete_private_link', { linkId: 'link-1' });
    expect(graph.deleteLink).toHaveBeenCalledWith('owner', 'link-1');

    graph.deletePrivateThing.mockResolvedValue({ deleted: true, id: 'thing-1', notesRemoved: 1, linksRemoved: 2 });
    const removed = await tool('oc_delete_private_thing', { thingId: 'thing-1' });
    expect(JSON.parse(removed.result.content[0].text)).toEqual({ deleted: true, id: 'thing-1', notesRemoved: 1, linksRemoved: 2 });
    expect(graph.deletePrivateThing).toHaveBeenCalledWith('owner', 'thing-1');

    graph.deletePrivateThing.mockRejectedValue(new PrivateGraphError(404, 'Not found'));
    const missing = await tool('oc_delete_private_thing', { thingId: 'someone-elses' });
    expect(missing.result.isError).toBe(true);
    expect(JSON.parse(missing.result.content[0].text)).toEqual({ error: 'Not found' });
  });

  it('records the agent client named by the hub, and lets it mark a relation as inferred', async () => {
    graph.addLink.mockResolvedValue({ id: 'link-2' });
    await tool('oc_add_private_link', { subjectKind: 'user', subjectId: 'bob', relation: 'knows', toKind: 'user', toId: 'carol', assertion: 'inferred' }, undefined, 'Claude Desktop');
    expect(graph.addLink).toHaveBeenLastCalledWith('owner', { kind: 'user', id: 'bob' }, 'knows', { kind: 'user', id: 'carol' }, { author: 'agent:Claude Desktop', source: 'connector', assertion: 'inferred' }, {});
    graph.addNote.mockResolvedValue({ id: 'note-2' });
    for (const client of ['x'.repeat(101), 'bad\nname', 7]) {
      await tool('oc_add_private_note', { subjectKind: 'user', subjectId: 'bob', text: 'hi' }, undefined, client);
      expect(graph.addNote).toHaveBeenLastCalledWith('owner', { kind: 'user', id: 'bob' }, 'hi', CONNECTOR);
    }
    expect((await call('tools/call', { name: 'oc_add_private_note', arguments: { subjectKind: 'user', subjectId: 'bob', text: 'x', assertion: 'certain' } })).status).toBe(400);
  });

  it('edits a relation, searches and reads a neighbourhood through the connector', async () => {
    graph.updateLink.mockResolvedValue({ link: { id: 'link-1', relation: 'cousin of', relationType: 'family' }, merged: true });
    const edited = await tool('oc_update_private_link', { linkId: 'link-1', relation: 'cousin of' });
    expect(JSON.parse(edited.result.content[0].text)).toEqual({ link: { id: 'link-1', relation: 'cousin of', relationType: 'family' }, merged: true });
    expect(graph.updateLink).toHaveBeenCalledWith('owner', 'link-1', { relation: 'cousin of' }, CONNECTOR);
    expect((await call('tools/call', { name: 'oc_update_private_link', arguments: { linkId: 'link-1', relation: 'x' } }, 'openchat:read')).status).toBe(403);
    // noos-ph2i.3: the assertion and facts change in place; the agent is still the editor, not the author of the edit's fields.
    graph.updateLink.mockResolvedValue({ link: { id: 'link-1', assertion: 'inferred' }, merged: false });
    await tool('oc_update_private_link', { linkId: 'link-1', assertion: 'inferred', relationType: 'related', since: '2019', context: '' });
    expect(graph.updateLink).toHaveBeenLastCalledWith('owner', 'link-1', { assertion: 'inferred', relationType: 'related', since: '2019', context: '' }, { ...CONNECTOR, assertion: 'inferred' });
    for (const args of [{ linkId: 'link-1', relationType: 'enemy' }, { linkId: 'link-1', since: 'x'.repeat(21) }, { linkId: 'link-1', context: 'x'.repeat(281) }]) {
      expect((await call('tools/call', { name: 'oc_update_private_link', arguments: args })).status).toBe(400);
    }

    graph.searchPrivate.mockResolvedValue({ things: [], links: [], truncated: false });
    await tool('oc_search_private', { query: 'maya', relationType: 'family', kind: 'person', limit: 5 }, 'openchat:read');
    expect(graph.searchPrivate).toHaveBeenCalledWith('owner', { q: 'maya', relationType: 'family', kind: 'person', limit: '5' });
    expect((await call('tools/call', { name: 'oc_search_private', arguments: { relationType: 'enemy' } }, 'openchat:read')).status).toBe(400);

    graph.getNeighbourhood.mockResolvedValue({ center: { kind: 'user', id: 'bob', name: 'Bob' }, depth: 2, nodes: [], links: [], truncated: false });
    await tool('oc_get_neighbourhood', { subjectKind: 'user', subjectId: 'bob', depth: 2 }, 'openchat:read');
    expect(graph.getNeighbourhood).toHaveBeenCalledWith('owner', { kind: 'user', id: 'bob' }, '2');
    expect((await call('tools/call', { name: 'oc_get_neighbourhood', arguments: { subjectKind: 'user', subjectId: 'bob', depth: 3 } }, 'openchat:read')).status).toBe(400);
  });

  it('returns ambiguous-name candidates to the agent instead of guessing', async () => {
    graph.addLink.mockRejectedValue(new PrivateGraphError(409, 'More than one person is called Alex.', { code: 'ambiguous_name', candidates: [{ kind: 'user', id: 'u1', name: 'Alex', use: { toKind: 'user', toId: 'u1' } }] }));
    const result = await tool('oc_add_private_link', { subjectKind: 'user', subjectId: 'bob', relation: 'knows', toKind: 'person', toName: 'Alex' });
    expect(result.result.isError).toBe(true);
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ code: 'ambiguous_name', candidates: [{ use: { toKind: 'user', toId: 'u1' } }] });
  });

  it('enforces scopes and rejects malformed arguments before any change', async () => {
    expect((await call('tools/call', { name: 'oc_add_private_note', arguments: { subjectKind: 'user', subjectId: 'bob', text: 'x' } }, 'openchat:read')).status).toBe(403);
    expect((await call('tools/call', { name: 'oc_get_person_private', arguments: { userId: 'bob' } }, 'openchat:write')).status).toBe(403);
    for (const args of [
      { subjectKind: 'company', subjectId: 'x', text: 'x' },
      { subjectKind: 'user', subjectId: 'bob', text: 'x', ownerId: 'someone-else' },
    ]) expect((await call('tools/call', { name: 'oc_add_private_note', arguments: args })).status).toBe(400);
    expect((await call('tools/call', { name: 'oc_set_person_private', arguments: { userId: 'bob', important: 'yes' } })).status).toBe(400);
    expect((await call('tools/call', { name: 'oc_add_private_link', arguments: { subjectKind: 'user', subjectId: 'bob', relation: 'knows', toKind: 'planet' } })).status).toBe(400);
    expect((await call('tools/call', { name: 'oc_delete_private_thing', arguments: { thingId: 't1' } }, 'openchat:read')).status).toBe(403);
    expect((await call('tools/call', { name: 'oc_delete_private_thing', arguments: { thingId: 'x'.repeat(65) } })).status).toBe(400);
    expect((await call('tools/call', { name: 'oc_delete_private_thing', arguments: {} })).status).toBe(400);
    expect(graph.deletePrivateThing).not.toHaveBeenCalled();
    expect(graph.addNote).not.toHaveBeenCalled();
    expect(graph.updatePersonCard).not.toHaveBeenCalled();
    expect(graph.addLink).not.toHaveBeenCalled();
  });

  it('edits notes in place with revision guards and lists revisions', async () => {
    graph.updateNote.mockResolvedValue({ id: 'note-1', text: 'New', revision: 2 });
    const edited = await tool('oc_update_private_note', { noteId: 'note-1', text: 'New', ifRevision: 1 });
    expect(edited.result.isError).toBeUndefined();
    expect(graph.updateNote).toHaveBeenCalledWith('owner', 'note-1', 'New', 1, expect.objectContaining({ author: expect.stringMatching(/^agent:/), source: 'connector' }));
    graph.updateNote.mockRejectedValue(new PrivateGraphError(409, 'This note was changed elsewhere. Choose which version to keep.', { code: 'stale_revision', note: { id: 'note-1', text: 'Theirs', revision: 3 } }));
    const stale = await tool('oc_update_private_note', { noteId: 'note-1', text: 'Mine', ifRevision: 2 });
    expect(stale.result.isError).toBe(true);
    expect(JSON.parse(stale.result.content[0].text)).toMatchObject({ code: 'stale_revision', note: { text: 'Theirs' } });
    graph.listNoteRevisions.mockResolvedValue({ note: { id: 'note-1' }, revisions: [{ revision: 1, text: 'Old' }] });
    expect(JSON.parse((await tool('oc_list_note_revisions', { noteId: 'note-1' }, 'openchat:read')).result.content[0].text).revisions[0].text).toBe('Old');
  });

  it('records person fields as assertions: Wi-Fi as ssid/password, history with status, marks and undo', async () => {
    graph.setPersonField.mockResolvedValue({ operationId: 'fop_1', fields: [] });
    await tool('oc_set_person_field', { thingId: 'thing-1', kind: 'wifi', ssid: 'Net', password: 'pw', label: 'guest', clientRequestId: 'r1' });
    expect(graph.setPersonField).toHaveBeenLastCalledWith('owner', 'thing-1', { kind: 'wifi', label: 'guest', clientRequestId: 'r1', value: { ssid: 'Net', password: 'pw' } }, expect.objectContaining({ source: 'connector' }), 'ideaflow-grant:synthetic');
    await tool('oc_set_person_field', { thingId: 'thing-1', kind: 'address', value: '832 Addison St, Berkeley', source: 'imessage', observedAt: '2017-01-30', status: 'former', evidence: { messageDate: '2017-01-30' }, clientRequestId: 'r2' });
    expect(graph.setPersonField.mock.calls.at(-1)![2]).toEqual({ kind: 'address', value: '832 Addison St, Berkeley', source: 'imessage', observedAt: '2017-01-30', status: 'former', evidence: { messageDate: '2017-01-30' }, clientRequestId: 'r2' });
    await tool('oc_set_person_field', { thingId: 'thing-1', kind: 'context', value: 'Qigong', contextType: 'interest', assertion: 'inferred', clientRequestId: 'r3' });
    expect(graph.setPersonField.mock.calls.at(-1)![2]).toEqual({ kind: 'context', value: { text: 'Qigong', type: 'interest' }, assertion: 'inferred', clientRequestId: 'r3' });
    expect((await tool('oc_set_person_field', { thingId: 'thing-1', kind: 'email', value: 'a@b.co' })).error.code).toBe(-32602);
    graph.markPersonField.mockResolvedValue({ operationId: 'fop_2', fields: [] });
    await tool('oc_mark_person_field', { thingId: 'thing-1', action: 'undo', operationId: 'fop_1', clientRequestId: 'u1' });
    expect(graph.markPersonField).toHaveBeenLastCalledWith('owner', 'thing-1', { action: 'undo', operationId: 'fop_1', clientRequestId: 'u1' }, expect.anything());
    expect((await tool('oc_mark_person_field', { thingId: 'thing-1', action: 'delete', key: 'k', clientRequestId: 'x' })).error.code).toBe(-32602);
  });

  it('reveals a masked value only through the explicit field read, with read scope', async () => {
    graph.revealPersonField.mockResolvedValue({ key: 'wifi:abc', kind: 'wifi', value: { ssid: 'Net', password: 'pw' } });
    const read = await tool('oc_get_person_field', { thingId: 'thing-1', key: 'wifi:abc' }, 'openchat:read');
    expect(JSON.parse(read.result.content[0].text).value.password).toBe('pw');
    expect(graph.revealPersonField).toHaveBeenCalledWith('owner', 'thing-1', 'wifi:abc');
  });
});
