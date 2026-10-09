import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addLink: vi.fn(), addNote: vi.fn(), createPrivateThing: vi.fn(), deleteLink: vi.fn(), deleteNote: vi.fn(), deletePrivateThing: vi.fn(), getPersonOverlay: vi.fn(), getThing: vi.fn(),
  listDue: vi.fn(), listThings: vi.fn(), updateNote: vi.fn(), updatePersonCard: vi.fn(), updateLink: vi.fn(), searchPrivate: vi.fn(), getNeighbourhood: vi.fn(),
}));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, ...mocks };
});
import privateGraphRoutes from '../src/routes/privateGraph.js';
import { PrivateGraphError } from '../src/services/privateGraph.js';

describe('private graph routes', () => {
  let server: Server;
  let baseUrl: string;
  const token = () => `Bearer ${jwt.sign({ userId: 'alice', email: 'alice@example.test' }, process.env.JWT_SECRET!)}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}/api/private${path}`, { ...init, headers: { Authorization: token(), 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'private-graph-route-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/private', privateGraphRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('requires sign-in on every route', async () => {
    for (const [method, path] of [['GET', '/due'], ['GET', '/people/bob'], ['PATCH', '/people/bob'], ['POST', '/people/bob/notes'], ['POST', '/people/bob/links'], ['GET', '/things'], ['POST', '/things'], ['GET', '/things/t1'], ['POST', '/things/t1/notes'], ['POST', '/things/t1/links'], ['PATCH', '/notes/n1'], ['DELETE', '/notes/n1'], ['DELETE', '/links/l1'], ['DELETE', '/things/t1']]) {
      expect((await fetch(`${baseUrl}/api/private${path}`, { method })).status, `${method} ${path}`).toBe(401);
    }
    expect(Object.values(mocks).every(mock => mock.mock.calls.length === 0)).toBe(true);
  });

  it('always acts for the signed-in owner, whatever the request body claims', async () => {
    mocks.getPersonOverlay.mockResolvedValue({ userId: 'bob', card: {}, notes: [], links: [] });
    mocks.addNote.mockResolvedValue({ id: 'n1', text: 'hi' });
    mocks.updatePersonCard.mockResolvedValue({ important: true });
    mocks.addLink.mockResolvedValue({ id: 'l1' });
    expect((await call('/people/bob')).status).toBe(200);
    expect(mocks.getPersonOverlay).toHaveBeenCalledWith('alice', 'bob');
    expect((await call('/people/bob/notes', { method: 'POST', body: JSON.stringify({ text: 'hi', ownerId: 'mallory' }) })).status).toBe(201);
    expect(mocks.addNote).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, 'hi', { author: 'owner', source: 'app', assertion: 'stated' });
    expect((await call('/people/bob', { method: 'PATCH', body: JSON.stringify({ important: true, ownerId: 'mallory' }) })).status).toBe(200);
    expect(mocks.updatePersonCard).toHaveBeenCalledWith('alice', 'bob', { important: true });
    expect((await call('/people/bob', { method: 'PATCH', body: JSON.stringify({ ownerId: 'mallory' }) })).status).toBe(400);
    expect(mocks.updatePersonCard).toHaveBeenCalledTimes(1);
    expect((await call('/things/t1/links', { method: 'POST', body: JSON.stringify({ relation: 'part of', to: { kind: 'project', name: 'Atlas' } }) })).status).toBe(201);
    expect(mocks.addLink).toHaveBeenCalledWith('alice', { kind: 'thing', id: 't1' }, 'part of', { kind: 'project', name: 'Atlas' }, { author: 'owner', source: 'app', assertion: 'stated' });
  });

  it('records the signed-in owner as author whatever the body claims', async () => {
    mocks.addLink.mockResolvedValue({ id: 'l1' });
    expect((await call('/people/bob/links', { method: 'POST', body: JSON.stringify({ relation: 'knows', to: { kind: 'user', id: 'carol' }, author: 'agent:Spoof', source: 'connector', assertion: 'inferred' }) })).status).toBe(201);
    expect(mocks.addLink).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, 'knows', { kind: 'user', id: 'carol' }, { author: 'owner', source: 'app', assertion: 'stated' });
  });

  it('edits a relation, searches and reads a neighbourhood for the signed-in owner only', async () => {
    mocks.updateLink.mockResolvedValue({ link: { id: 'l1', relation: 'cousin of' }, merged: false });
    const edited = await call('/links/l1', { method: 'PATCH', body: JSON.stringify({ relation: 'cousin of', ownerId: 'mallory' }) });
    expect([edited.status, await edited.json()]).toEqual([200, { link: { id: 'l1', relation: 'cousin of' }, merged: false }]);
    expect(mocks.updateLink).toHaveBeenCalledWith('alice', 'l1', 'cousin of', { author: 'owner', source: 'app', assertion: 'stated' });

    mocks.searchPrivate.mockResolvedValue({ things: [], links: [], truncated: false });
    expect((await call('/search?q=maya&relationType=family&kind=person&limit=5')).status).toBe(200);
    expect(mocks.searchPrivate).toHaveBeenCalledWith('alice', { q: 'maya', relationType: 'family', kind: 'person', limit: '5' });

    mocks.getNeighbourhood.mockResolvedValue({ center: { kind: 'user', id: 'bob', name: 'Bob' }, depth: 2, nodes: [], links: [], truncated: false });
    expect((await call('/neighbourhood?subjectKind=user&subjectId=bob&depth=2')).status).toBe(200);
    expect(mocks.getNeighbourhood).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, '2');
    for (const bad of ['/neighbourhood', '/neighbourhood?subjectKind=planet&subjectId=x', '/neighbourhood?subjectKind=user']) expect((await call(bad)).status, bad).toBe(400);
    expect(mocks.getNeighbourhood).toHaveBeenCalledTimes(1);
    for (const [method, path] of [['PATCH', '/links/l1'], ['GET', '/search'], ['GET', '/neighbourhood']]) expect((await fetch(`${baseUrl}/api/private${path}`, { method })).status, `${method} ${path}`).toBe(401);
  });

  it('creates a saved person only for the signed-in owner without account binding', async () => {
    mocks.createPrivateThing.mockResolvedValue({id:'saved-person',kind:'person',name:'Chet'});
    const response = await call('/things', {method:'POST',body:JSON.stringify({kind:'person',name:'Chet',ownerId:'mallory',userId:'other-account'})});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({id:'saved-person',kind:'person',name:'Chet'});
    expect(mocks.createPrivateThing).toHaveBeenCalledWith('alice','person','Chet');
  });

  it('deletes a saved thing only for the signed-in owner, and reports a missing one as not found', async () => {
    mocks.deletePrivateThing.mockResolvedValueOnce({ deleted: true, id: 't1', notesRemoved: 2, linksRemoved: 1 });
    const response = await call('/things/t1', { method: 'DELETE', body: JSON.stringify({ ownerId: 'mallory' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, id: 't1', notesRemoved: 2, linksRemoved: 1 });
    expect(mocks.deletePrivateThing).toHaveBeenCalledWith('alice', 't1');
    mocks.deletePrivateThing.mockRejectedValueOnce(new PrivateGraphError(404, 'Not found'));
    const again = await call('/things/t1', { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: 'Not found' });
  });

  it('reports a missing or unavailable person as not found, never as a sign-in failure', async () => {
    mocks.getPersonOverlay.mockRejectedValue(new PrivateGraphError(404, 'Person unavailable'));
    const response = await call('/people/blocked');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Person unavailable' });
    mocks.deleteNote.mockRejectedValue(new Error('bolt: password=secret'));
    const failed = await call('/notes/n1', { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
  });
});
