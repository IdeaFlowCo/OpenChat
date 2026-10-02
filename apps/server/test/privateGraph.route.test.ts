import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addLink: vi.fn(), addNote: vi.fn(), deleteLink: vi.fn(), deleteNote: vi.fn(), getPersonOverlay: vi.fn(), getThing: vi.fn(),
  listDue: vi.fn(), listThings: vi.fn(), updateNote: vi.fn(), updatePersonCard: vi.fn(),
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
    for (const [method, path] of [['GET', '/due'], ['GET', '/people/bob'], ['PATCH', '/people/bob'], ['POST', '/people/bob/notes'], ['POST', '/people/bob/links'], ['GET', '/things'], ['GET', '/things/t1'], ['POST', '/things/t1/notes'], ['POST', '/things/t1/links'], ['PATCH', '/notes/n1'], ['DELETE', '/notes/n1'], ['DELETE', '/links/l1']]) {
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
    expect(mocks.addNote).toHaveBeenCalledWith('alice', { kind: 'user', id: 'bob' }, 'hi');
    expect((await call('/people/bob', { method: 'PATCH', body: JSON.stringify({ important: true, ownerId: 'mallory' }) })).status).toBe(200);
    expect(mocks.updatePersonCard).toHaveBeenCalledWith('alice', 'bob', { important: true });
    expect((await call('/people/bob', { method: 'PATCH', body: JSON.stringify({ ownerId: 'mallory' }) })).status).toBe(400);
    expect(mocks.updatePersonCard).toHaveBeenCalledTimes(1);
    expect((await call('/things/t1/links', { method: 'POST', body: JSON.stringify({ relation: 'part of', to: { kind: 'project', name: 'Atlas' } }) })).status).toBe(201);
    expect(mocks.addLink).toHaveBeenCalledWith('alice', { kind: 'thing', id: 't1' }, 'part of', { kind: 'project', name: 'Atlas' });
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
