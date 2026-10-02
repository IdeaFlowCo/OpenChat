import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ scopes: undefined as string[] | undefined, getPersonOverlay: vi.fn(), addNote: vi.fn(), deleteNote: vi.fn() }));
vi.mock('../src/middleware/resolveActor.js', () => ({
  resolveActor: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'alice', email: '' };
    req.agentScopes = mocks.scopes;
    next();
  },
}));
vi.mock('../src/services/privateGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/privateGraph.js')>('../src/services/privateGraph.js');
  return { ...actual, getPersonOverlay: mocks.getPersonOverlay, addNote: mocks.addNote, deleteNote: mocks.deleteNote };
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
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

  it('lets a read-only key look but not change, and a write-only key change but not look', async () => {
    mocks.scopes = ['read'];
    expect((await call('GET', '/people/bob')).status).toBe(200);
    expect((await call('POST', '/people/bob/notes', { text: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/notes/n1')).status).toBe(404);
    expect(mocks.addNote).not.toHaveBeenCalled();
    expect(mocks.deleteNote).not.toHaveBeenCalled();
    mocks.scopes = ['write'];
    expect((await call('GET', '/people/bob')).status).toBe(404);
    expect((await call('POST', '/people/bob/notes', { text: 'x' })).status).toBe(201);
    mocks.scopes = [];
    expect((await call('GET', '/people/bob')).status).toBe(404);
  });

  it('gives a signed-in person and a read-write key both', async () => {
    for (const scopes of [undefined, ['read', 'write']]) {
      mocks.scopes = scopes;
      expect((await call('GET', '/people/bob')).status).toBe(200);
      expect((await call('POST', '/people/bob/notes', { text: 'x' })).status).toBe(201);
      expect(mocks.addNote).toHaveBeenLastCalledWith('alice', { kind: 'user', id: 'bob' }, 'x');
    }
  });
});
