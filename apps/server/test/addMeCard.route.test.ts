import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  ensureDirectConversation: vi.fn(),
  changeFriend: vi.fn(),
  getFriendStatus: vi.fn(),
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
vi.mock('../src/services/friends.js', () => ({
  FriendError: class extends Error {},
  changeFriend: mocks.changeFriend,
  getFriendStatus: mocks.getFriendStatus,
}));

import cardRoutes from '../src/routes/addMeCard.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';

function cardRecord(ownerId: string, cardProps: Record<string, unknown>, ownerName = 'Jacob Cole') {
  return {
    records: [{
      get: (key: string) => {
        if (key === 'ownerId') return ownerId;
        if (key === 'owner') return { name: ownerName, email: 'private@example.test', phone: '+15555550123', avatarUrl: 'https://cdn.example.com/a.png', profileStatusText: 'Here' };
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
    mocks.changeFriend.mockReset();
    mocks.getFriendStatus.mockReset();
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
    expect(body).toEqual({ name: 'Jacob Cole', isBot: false, headline: null, avatarUrl: null, status: null, linkedIn: null, x: null, link: null });
    expect(JSON.stringify(body)).not.toContain('owner-id-secret');
  });

  it('404s for a revoked or unknown token without touching the database for malformed ones', async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    expect((await fetch(`${baseUrl}/api/card/${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/card/not-a-token`)).status).toBe(404);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('exports only active, published card fields without login or caching', async () => {
    mocks.run.mockResolvedValueOnce(cardRecord('owner-id-secret', {
      showAvatar: false, showStatus: false, showHeadline: true,
      headline: 'Founder', showLinkedIn: true, linkedIn: 'https://example.com/me',
      showLink: false, link: 'https://private.example.test',
    }));
    const response = await fetch(`${baseUrl}/api/card/${TOKEN}/contact.vcf`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('text/vcard');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="openchat-contact.vcf"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain('FN:Jacob Cole\r\n');
    expect(body).toContain('NOTE:Founder\r\n');
    expect(body).toContain('URL:https://example.com/me\r\n');
    expect(body).toContain(`URL:https://chat.ideaflow.app/c/${TOKEN}\r\n`);
    for (const secret of ['private@example.test', '+15555550123', 'owner-id-secret', 'private.example.test']) {
      expect(body).not.toContain(secret);
    }
  });

  it.each([
    ['chat.globalbr.ai', 'https://chat.globalbr.ai'],
    ['chat.ideaflow.app', 'https://chat.ideaflow.app'],
  ])('exports the %s card URL for that public host', async (host, origin) => {
    mocks.run.mockResolvedValueOnce(cardRecord('owner-id', {}));
    const response = await request(server).get(`/api/card/${TOKEN}/contact.vcf`).set('Host', host);
    expect(response.status).toBe(200);
    expect(response.text).toContain(`URL:${origin}/c/${TOKEN}\r\n`);
  });

  it('rejects revoked and malformed vCard tokens', async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    const revoked = await fetch(`${baseUrl}/api/card/${TOKEN}/contact.vcf`);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${baseUrl}/api/card/invalid/contact.vcf`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/card/${TOKEN}%0A/contact.vcf`)).status).toBe(404);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('reflects field withdrawal and rotation on the next download', async () => {
    mocks.run
      .mockResolvedValueOnce(cardRecord('owner-id', { showLink: true, link: 'https://example.com/public' }))
      .mockResolvedValueOnce(cardRecord('owner-id', { showLink: false, link: 'https://example.com/public' }))
      .mockResolvedValueOnce({ records: [] });
    const first = await fetch(`${baseUrl}/api/card/${TOKEN}/contact.vcf`);
    expect(await first.text()).toContain('URL:https://example.com/public');
    const withdrawn = await fetch(`${baseUrl}/api/card/${TOKEN}/contact.vcf`);
    expect(await withdrawn.text()).not.toContain('example.com/public');
    const revoked = await fetch(`${baseUrl}/api/card/${TOKEN}/contact.vcf`, {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
  });

  it('adds the owner as a contact through the direct-conversation path', async () => {
    mocks.run.mockResolvedValueOnce(cardRecord('owner-id', {}));
    mocks.ensureDirectConversation.mockResolvedValueOnce({ conversation: { id: 'conv-1' }, created: true });
    const response = await fetch(`${baseUrl}/api/card/${TOKEN}/add`, { method: 'POST', headers: { authorization } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ conversationId: 'conv-1', created: true });
    expect(mocks.ensureDirectConversation).toHaveBeenCalledWith('scanner', 'owner-id', undefined);
  });

  it('keeps legacy add as a DM while new card actions use the friend service', async () => {
    mocks.run.mockResolvedValueOnce(cardRecord('owner-id', {}));
    mocks.changeFriend.mockResolvedValueOnce({ userId: 'owner-id', state: 'outgoing', updatedAt: 'now' });
    const response = await fetch(`${baseUrl}/api/card/${TOKEN}/friend-request`, { method: 'POST', headers: { authorization } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'outgoing' });
    expect(mocks.changeFriend).toHaveBeenCalledWith('scanner', 'owner-id', 'request', 'card', true, TOKEN);
    expect(mocks.ensureDirectConversation).not.toHaveBeenCalled();
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
