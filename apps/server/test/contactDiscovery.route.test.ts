import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import chatRouter from '../src/routes/chat.js';

type DiscoveryMode = 'name' | 'email_only' | 'hidden';
type StoredUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  discoveryMode?: DiscoveryMode;
};

const caller: StoredUser = {
  id: 'route-test-user',
  name: 'Route Test User',
  email: 'route-test@example.test',
};
const nameDiscoverable: StoredUser = {
  id: 'name-user',
  name: 'Alice Other',
  email: 'alice.other@example.test',
  avatarUrl: 'https://cdn.example.test/alice.jpg',
};
const emailOnly: StoredUser = {
  id: 'email-only-user',
  name: 'Bob Private',
  email: 'bob.private@example.test',
  discoveryMode: 'email_only',
};
const hidden: StoredUser = {
  id: 'hidden-user',
  name: 'Eve Hidden',
  email: 'eve.hidden@example.test',
  discoveryMode: 'hidden',
};

const publicProjection = (user: StoredUser) => ({
  id: user.id,
  name: user.name,
  ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
});

function discoveryResult(params: Record<string, unknown>) {
  const users = [caller, nameDiscoverable, emailOnly, hidden];
  const actor = users.find(user => user.id === params.userId);
  if (!actor) return { records: [] };

  const name = String(params.name ?? params.contactName ?? '').toLowerCase();
  const email = String(params.email ?? params.contactEmail ?? '').toLowerCase();
  const matches = users.filter(user => {
    if (params.selfOnly === true && user.id === actor.id) return true;
    if (user.id === actor.id || user.discoveryMode === 'hidden') return false;
    if (email && user.email.toLowerCase() === email) return true;
    return Boolean(name)
      && (user.discoveryMode ?? 'name') === 'name'
      && user.name.toLowerCase().includes(name);
  });

  return { records: matches.map(user => ({ get: () => publicProjection(user) })) };
}

describe('privacy-conscious contact discovery routes', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: caller.id, email: caller.email },
      'dev-secret-change-me',
    )}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockReset();
    mocks.run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('discoveryMode')) return discoveryResult(params);
      return { records: [] };
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('returns only a privacy-safe self projection for an empty query', async () => {
    const response = await fetch(`${baseUrl}/api/chat/contacts`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([publicProjection(caller)]);
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining('u.id = $userId'), expect.objectContaining({
      userId: caller.id,
      selfOnly: true,
      email: '',
      name: '',
      limit: expect.anything(),
    }));
  });

  it('finds default accounts by partial display name without exposing email', async () => {
    const response = await fetch(`${baseUrl}/api/chat/contacts?q=Alice`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([publicProjection(nameDiscoverable)]);
    expect(body[0]).not.toHaveProperty('email');
    expect(mocks.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      userId: caller.id,
      selfOnly: false,
      email: '',
      name: 'alice',
      limit: expect.anything(),
    }));
    const cypher = String(mocks.run.mock.calls[0][0]);
    expect(cypher).toContain('NOT (u)-[:BLOCKED]->(actor)');
    expect(cypher).toContain('LIMIT $limit');
  });

  it('does not find email-only or hidden accounts by name', async () => {
    const emailOnlyResponse = await fetch(`${baseUrl}/api/chat/contacts?q=Bob`, {
      headers: { Authorization: authorization },
    });
    const hiddenResponse = await fetch(`${baseUrl}/api/chat/contacts?q=Eve`, {
      headers: { Authorization: authorization },
    });

    expect(await emailOnlyResponse.json()).toEqual([]);
    expect(await hiddenResponse.json()).toEqual([]);
  });

  it('finds an email-only account by exact email without echoing the email', async () => {
    const response = await fetch(`${baseUrl}/api/chat/contacts?q=${encodeURIComponent('  BOB.PRIVATE@EXAMPLE.TEST  ')}`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([publicProjection(emailOnly)]);
    expect(body[0]).not.toHaveProperty('email');
  });

  it('does not find a hidden account even by exact email', async () => {
    const response = await fetch(`${baseUrl}/api/chat/contacts?q=${hidden.email}`, {
      headers: { Authorization: authorization },
    });
    expect(await response.json()).toEqual([]);
  });

  it('uses the same name and exact-email rules in global search', async () => {
    const nameResponse = await fetch(`${baseUrl}/api/chat/search?q=Alice`, {
      headers: { Authorization: authorization },
    });
    const emailResponse = await fetch(`${baseUrl}/api/chat/search?q=${encodeURIComponent(emailOnly.email)}`, {
      headers: { Authorization: authorization },
    });

    const nameBody = await nameResponse.json();
    expect(nameBody.contacts).toEqual([publicProjection(nameDiscoverable)]);
    expect(nameBody.contacts[0].avatarUrl).toBe(nameDiscoverable.avatarUrl);
    expect((await emailResponse.json()).contacts).toEqual([publicProjection(emailOnly)]);
    const contactCalls = mocks.run.mock.calls.filter(([cypher]) => String(cypher).includes('contactName'));
    expect(contactCalls[0][1]).toMatchObject({ contactName: 'alice', contactEmail: '' });
    expect(contactCalls[1][1]).toMatchObject({ contactName: '', contactEmail: emailOnly.email });
    expect(String(contactCalls[0][0])).toContain('.avatarUrl');
  });

  it('projects avatarUrl for every person-bearing global search result', async () => {
    await fetch(`${baseUrl}/api/chat/search?q=Alice`, {
      headers: { Authorization: authorization },
    });

    const cypher = mocks.run.mock.calls.map(([query]) => String(query));
    const messageQuery = cypher.find(query => query.includes('conversationTitle: c.title'));
    const conversationQuery = cypher.find(query => query.includes('participants: participants'));
    const contactQuery = cypher.find(query => query.includes('contactName'));

    expect(messageQuery).toContain('sender: sender { .id, .name, .avatarUrl, .isBot }');
    expect(conversationQuery).toContain('participant { .id, .name, .avatarUrl, .isBot }');
    expect(contactQuery).toContain('.avatarUrl');
  });

  it('normalizes the dedicated exact-email lookup and returns no email field', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{ get: () => publicProjection(emailOnly) }],
    });

    const response = await fetch(`${baseUrl}/api/chat/users/by-email/${encodeURIComponent('BOB.PRIVATE@EXAMPLE.TEST')}`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicProjection(emailOnly));
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining("discoveryMode, 'name'"), expect.objectContaining({
      userId: caller.id,
      email: emailOnly.email,
    }));
  });

  it('does not treat a non-email by-email path as a name lookup', async () => {
    const response = await fetch(`${baseUrl}/api/chat/users/by-email/Alice`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
