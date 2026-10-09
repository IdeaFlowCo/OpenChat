import { createHash, createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: state.run, close: async () => {} }) }) }));
const graph = vi.hoisted(() => ({
  addLink: vi.fn(), addNote: vi.fn(), deleteLink: vi.fn(), deleteNote: vi.fn(), deletePrivateThing: vi.fn(), getPersonOverlay: vi.fn(), getThing: vi.fn(),
  getUnlinkedPersonOverlay: vi.fn(), listDue: vi.fn(), resolvePrivateThing: vi.fn(), listOwnerLinks: vi.fn(), listThings: vi.fn(), updatePersonCard: vi.fn(),
  updateLink: vi.fn(), searchPrivate: vi.fn(), getNeighbourhood: vi.fn(),
}));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, ...graph };
});
import { handleIdeaflowConnector, connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import privateGraphRoutes from '../src/routes/privateGraph.js';
import { PrivateGraphError } from '../src/services/privateGraph.js';

const secret = 'test-only-connector-secret-32-bytes-minimum';
function sign(body: string, scope: string, client?: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://id.ideaflow.app/connector', aud: 'https://chat.ideaflow.app/mcp', identity_issuer: 'https://id.ideaflow.app/api/auth', sub: 'subject', scope, iat: now, exp: now + 60, jti: randomUUID(), body_sha256: createHash('sha256').update(body).digest('hex'), ...(client !== undefined ? { client } : {}) })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
const PRIVATE_READS = ['oc_get_person_private', 'oc_get_unlinked_person_private', 'oc_list_private_links', 'oc_search_private', 'oc_get_neighbourhood', 'oc_list_private_things', 'oc_get_private_thing', 'oc_list_catch_up'];
const PRIVATE_WRITES = ['oc_set_person_private', 'oc_add_private_note', 'oc_delete_private_note', 'oc_add_private_link', 'oc_update_private_link', 'oc_delete_private_link', 'oc_save_private_thing', 'oc_delete_private_thing'];
const CONNECTOR = { author: 'agent:Ideaflow connector', source: 'connector', assertion: 'stated' };

describe('private people knowledge through the shared Ideaflow connector', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    const app = express();
    app.post('/api/connector/mcp', express.raw({ type: 'application/json' }), handleIdeaflowConnector);
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
      expect(entry.description).toMatch(/shown in OpenChat \(an Unlinked view is coming\)/);
      expect(entry.description).not.toMatch(/OpenChat and Unlinked/);
    }
    for (const name of ['oc_search_private', 'oc_get_neighbourhood', 'oc_get_person_private', 'oc_list_private_links', 'oc_get_private_thing']) {
      expect(all.find((value: any) => value.name === name).description, name).toMatch(/author .*source .*assertion/);
    }
    const search = all.find((value: any) => value.name === 'oc_search_private');
    expect(search.inputSchema.properties.relationType.enum).toEqual(['knows', 'family', 'works_at', 'worked_with', 'works_on', 'attended', 'interested_in', 'other']);
    expect(all.find((value: any) => value.name === 'oc_update_private_link').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(all.find((value: any) => value.name === 'oc_delete_private_link').annotations.destructiveHint).toBe(true);
    const remove = all.find((value: any) => value.name === 'oc_delete_private_thing');
    expect(remove.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(remove.description).toMatch(/undo for oc_save_private_thing/);
    expect(remove.description).toMatch(/private notes and every private relation/);
    expect(all.find((value: any) => value.name === 'oc_save_private_thing').annotations.destructiveHint).toBe(false);
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
    expect(graph.addLink).toHaveBeenCalledWith('owner', { kind: 'unlinked', id: 'maya-1' }, 'sister of', { kind: 'person', name: 'Priya', createNew: true, clientRequestId: 'req-1' }, CONNECTOR);

    graph.addNote.mockResolvedValue({ id: 'note-1' });
    await tool('oc_add_private_note', { subjectKind: 'user', subjectId: 'bob', text: 'Met at dinner' });
    expect(graph.addNote).toHaveBeenCalledWith('owner', { kind: 'user', id: 'bob' }, 'Met at dinner', CONNECTOR);

    graph.updatePersonCard.mockResolvedValue({ important: true });
    await tool('oc_set_person_private', { userId: 'bob', important: true, cadenceDays: null });
    expect(graph.updatePersonCard).toHaveBeenCalledWith('owner', 'bob', { important: true, cadenceDays: null });

    graph.resolvePrivateThing.mockResolvedValue({ id: 'thing-1', kind: 'person', name: 'Maya' });
    const saved = await tool('oc_save_private_thing', { kind: 'person', name: 'Maya', createNew: true, clientRequestId: 'req-2' });
    expect(JSON.parse(saved.result.content[0].text)).toEqual({ id: 'thing-1', kind: 'person', name: 'Maya' });
    expect(graph.resolvePrivateThing).toHaveBeenCalledWith('owner', { kind: 'person', name: 'Maya', createNew: true, clientRequestId: 'req-2' });

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
    expect(graph.addLink).toHaveBeenLastCalledWith('owner', { kind: 'user', id: 'bob' }, 'knows', { kind: 'user', id: 'carol' }, { author: 'agent:Claude Desktop', source: 'connector', assertion: 'inferred' });
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
    expect(graph.updateLink).toHaveBeenCalledWith('owner', 'link-1', 'cousin of', CONNECTOR);
    expect((await call('tools/call', { name: 'oc_update_private_link', arguments: { linkId: 'link-1', relation: 'x' } }, 'openchat:read')).status).toBe(403);

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
});
