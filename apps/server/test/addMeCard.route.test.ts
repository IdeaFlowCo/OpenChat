import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  ensureDirectConversation: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: mocks.run,
      close: mocks.close,
      executeWrite: (cb: (tx: unknown) => unknown) => cb({ run: mocks.run }),
    }),
  }),
}));

vi.mock('../src/services/directConversation.js', () => ({
  DirectConversationNotAllowedError: class extends Error {},
  ensureDirectConversation: mocks.ensureDirectConversation,
}));

import cardRoutes from '../src/routes/addMeCard.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';

function cardRecord(ownerId: string, cardProps: Record<string, unknown>) {
  return {
    records: [{
      get: (key: string) => {
        if (key === 'ownerId') return ownerId;
        if (key === 'owner') return { name: 'Jacob Cole', avatarUrl: 'https://cdn.example.com/a.png', profileStatusText: 'Here' };
        if (key === 'card') return { properties: { token: TOKEN, ...cardProps } };
        return null;
      },
    }],
  };
}

describe('AddMe card routes', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'addme-card-route-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/card', cardRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authorization = `Bearer ${jwt.sign({ userId: 'scanner', email: 'scanner@example.test' }, process.env.JWT_SECRET)}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.ensureDirectConversation.mockReset();
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('serves a stranger only the projection, never the owner id', async () => {
    mocks.run.mockResolvedValueOnce(cardRecord('owner-id-secret', { showAvatar: false, showStatus: false }));
    const response = await fetch(`${baseUrl}/api/card/${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ name: 'Jacob Cole', isBot: false, headline: null, avatarUrl: null, status: null, link: null });
    expect(JSON.stringify(body)).not.toContain('owner-id-secret');
  });

  it('404s for a revoked or unknown token without touching the database for malformed ones', async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    expect((await fetch(`${baseUrl}/api/card/${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/card/not-a-token`)).status).toBe(404);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('adds the owner as a contact through the direct-conversation path', async () => {
    mocks.run.mockResolvedValueOnce(cardRecord('owner-id', {}));
    mocks.ensureDirectConversation.mockResolvedValueOnce({ conversation: { id: 'conv-1' }, created: true });
    const response = await fetch(`${baseUrl}/api/card/${TOKEN}/add`, { method: 'POST', headers: { authorization } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ conversationId: 'conv-1', created: true });
    expect(mocks.ensureDirectConversation).toHaveBeenCalledWith('scanner', 'owner-id', undefined);
  });

  it('refuses to add yourself and requires sign-in', async () => {
    mocks.run.mockResolvedValueOnce(cardRecord('scanner', {}));
    const own = await fetch(`${baseUrl}/api/card/${TOKEN}/add`, { method: 'POST', headers: { authorization } });
    expect(own.status).toBe(400);
    expect(mocks.ensureDirectConversation).not.toHaveBeenCalled();
    expect((await fetch(`${baseUrl}/api/card/${TOKEN}/add`, { method: 'POST' })).status).toBe(401);
  });

  it('rejects invalid settings before writing', async () => {
    const response = await fetch(`${baseUrl}/api/card/me`, {
      method: 'PATCH',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ showAvatar: 'yes' }),
    });
    expect(response.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
