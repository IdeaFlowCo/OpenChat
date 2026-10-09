import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ scopes: undefined as string[] | undefined, getPersonOverlay: vi.fn(), createPrivateThing: vi.fn(), addNote: vi.fn(), deleteNote: vi.fn(), deletePrivateThing: vi.fn() }));
vi.mock('../src/middleware/resolveActor.js', () => ({
  resolveActor: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'alice', email: '' };
    req.agentScopes = mocks.scopes;
    if (mocks.scopes) { req.agentKeyId = 'key-1'; req.agentKeyLabel = 'Hermes'; }
    next();
  },
}));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, getPersonOverlay: mocks.getPersonOverlay, createPrivateThing: mocks.createPrivateThing, addNote: mocks.addNote, deleteNote: mocks.deleteNote, deletePrivateThing: mocks.deletePrivateThing };
});
import privateGraphRoutes from '../src/routes/privateGraph.js';

describe('private graph agent-key scopes', () => {
  let server: Server;
  let baseUrl: string;
  const call = (method: string, path: string, body?: unknown) => fetch(`${baseUrl}/api/private${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/private', privateGraphRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPersonOverlay.mockResolvedValue({ userId: 'bob', card: {}, notes: [], links: [] });
    mocks.addNote.mockResolvedValue({ id: 'n1' });
    mocks.deleteNote.mockResolvedValue({ deleted: true });
    mocks.createPrivateThing.mockResolvedValue({id:'private-person',kind:'person',name:'Chet'});
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

  it('lets a read-only key look but not change, and a write-only key change but not look', async () => {
    mocks.scopes = ['read'];
    expect((await call('GET', '/people/bob')).status).toBe(200);
    expect((await call('POST', '/people/bob/notes', { text: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/notes/n1')).status).toBe(404);
    expect(mocks.addNote).not.toHaveBeenCalled();
    expect((await call('DELETE', '/things/t1')).status).toBe(404);
    expect(mocks.deleteNote).not.toHaveBeenCalled();
    expect(mocks.deletePrivateThing).not.toHaveBeenCalled();
    mocks.scopes = ['write'];
    expect((await call('GET', '/people/bob')).status).toBe(404);
    mocks.deletePrivateThing.mockResolvedValue({ deleted: true, id: 't1', notesRemoved: 0, linksRemoved: 0 });
    expect((await call('DELETE', '/things/t1')).status).toBe(200);
    expect(mocks.deletePrivateThing).toHaveBeenCalledWith('alice', 't1');
    expect((await call('POST', '/people/bob/notes', { text: 'x' })).status).toBe(201);
    mocks.scopes = [];
    expect((await call('GET', '/people/bob')).status).toBe(404);
  });

  it('requires write scope to create a private named subject', async () => {
    mocks.scopes = ['read'];
    expect((await call('POST','/things',{kind:'person',name:'Chet'})).status).toBe(404);
    expect(mocks.createPrivateThing).not.toHaveBeenCalled();
    mocks.scopes = ['write'];
    expect((await call('POST','/things',{kind:'person',name:'Chet',ownerId:'mallory'})).status).toBe(201);
    expect(mocks.createPrivateThing).toHaveBeenCalledWith('alice','person','Chet');
  });

  it('gives a signed-in person and a read-write key both', async () => {
    for (const scopes of [undefined, ['read', 'write']]) {
      mocks.scopes = scopes;
      expect((await call('GET', '/people/bob')).status).toBe(200);
      expect((await call('POST', '/people/bob/notes', { text: 'x' })).status).toBe(201);
      expect(mocks.addNote).toHaveBeenLastCalledWith('alice', { kind: 'user', id: 'bob' }, 'x',
        scopes ? { author: 'agent:Hermes', source: 'direct-key', assertion: 'stated' } : { author: 'owner', source: 'app', assertion: 'stated' });
    }
  });

  it('lets an agent key mark what it writes as inferred, and refuses other assertions', async () => {
    mocks.scopes = ['read', 'write'];
    expect((await call('POST', '/people/bob/notes', { text: 'x', assertion: 'inferred' })).status).toBe(201);
    expect(mocks.addNote).toHaveBeenLastCalledWith('alice', { kind: 'user', id: 'bob' }, 'x', { author: 'agent:Hermes', source: 'direct-key', assertion: 'inferred' });
    expect((await call('POST', '/people/bob/notes', { text: 'x', assertion: 'certain' })).status).toBe(400);
    expect(mocks.addNote).toHaveBeenCalledTimes(1);
  });
});
