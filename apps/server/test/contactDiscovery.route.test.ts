import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: mocks.run,
      close: mocks.close,
    }),
  }),
}));

import chatRouter from '../src/routes/chat.js';

const caller = {
  id: 'route-test-user',
  name: 'Route Test User',
  email: 'route-test@example.test',
};
const other = {
  id: 'other-user',
  name: 'Alice Other',
  email: 'Alice.Other@Example.test',
};
const trustedCaller = {
  id: 'trusted-route-test-user',
  name: 'Trusted Route Test User',
  email: 'trusted-route-test@example.test',
  canBrowseUserDirectory: true,
};

type StoredUser = typeof caller | typeof other | typeof trustedCaller;

function resultWith(user: StoredUser | null) {
  return {
    records: user ? [{ get: () => user }] : [],
  };
}

function discoveryResult(params: Record<string, unknown>) {
  const users: StoredUser[] = [caller, trustedCaller, other];
  const actor = users.find(user => user.id === params.userId);
  if (!actor) return { records: [] };

  const search = String(params.search ?? params.contactSearch ?? '').toLowerCase();
  const email = String(params.email ?? params.contactEmail ?? '').toLowerCase();
  const canBrowse = 'canBrowseUserDirectory' in actor && actor.canBrowseUserDirectory === true;
  const matches = users.filter(user => canBrowse
    ? search === ''
      || user.name.toLowerCase().includes(search)
      || user.email.toLowerCase().includes(search)
      || (params.selfOnly === true && user.id === actor.id)
    : (params.selfOnly === true && user.id === actor.id)
      || (email !== '' && user.email.toLowerCase() === email))
    .sort((a, b) => {
      if (a.id === actor.id) return -1;
      if (b.id === actor.id) return 1;
      return a.name.localeCompare(b.name);
    });

  return {
    records: matches.map(user => ({
      get: () => ({ id: user.id, name: user.name, email: user.email }),
    })),
  };
}

describe('private contact discovery routes', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;
  let trustedAuthorization: string;

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
    trustedAuthorization = `Bearer ${jwt.sign(
      { userId: trustedCaller.id, email: trustedCaller.email },
      'dev-secret-change-me',
    )}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockReset();
    mocks.run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('coalesce(actor.canBrowseUserDirectory, false)')) {
        return discoveryResult(params);
      }
      return { records: [] };
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('returns only the caller for an empty contact query', async () => {
    const response = await fetch(`${baseUrl}/api/chat/contacts`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([caller]);
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining('u.id = $userId'), {
      userId: caller.id,
      search: '',
      selfOnly: true,
      email: '',
    });
  });

  it.each(['me', 'self', 'myself'])('returns only the caller for the %s keyword', async keyword => {
    const response = await fetch(`${baseUrl}/api/chat/contacts?q=${keyword}`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([caller]);
    expect(mocks.run).toHaveBeenCalledWith(expect.any(String), {
      userId: caller.id,
      search: keyword,
      selfOnly: true,
      email: '',
    });
  });

  it.each(['Alice', 'alice@', 'example.test', 'alice.other@example'])('keeps the ordinary contact result empty for partial discovery input %s', async partial => {
    const response = await fetch(`${baseUrl}/api/chat/contacts?q=${encodeURIComponent(partial)}`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(String(mocks.run.mock.calls[0][0])).toContain('canBrowseUserDirectory');
  });

  it('normalizes a complete email and performs one exact lookup', async () => {
    const response = await fetch(`${baseUrl}/api/chat/contacts?q=${encodeURIComponent('  ALICE.OTHER@EXAMPLE.TEST  ')}`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([other]);
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining('toLower(u.email) = $email'), {
      userId: caller.id,
      search: 'alice.other@example.test',
      selfOnly: false,
      email: 'alice.other@example.test',
    });
  });

  it('uses the stored capability for the same partial query and trusted browsing', async () => {
    const ordinaryPartialResponse = await fetch(`${baseUrl}/api/chat/contacts?q=Alice`, {
      headers: { Authorization: authorization },
    });
    const browseResponse = await fetch(`${baseUrl}/api/chat/contacts`, {
      headers: { Authorization: trustedAuthorization },
    });
    const partialResponse = await fetch(`${baseUrl}/api/chat/contacts?q=Alice`, {
      headers: { Authorization: trustedAuthorization },
    });

    expect(await ordinaryPartialResponse.json()).toEqual([]);
    expect(await browseResponse.json()).toEqual([
      { id: trustedCaller.id, name: trustedCaller.name, email: trustedCaller.email },
      other,
      caller,
    ]);
    expect(await partialResponse.json()).toEqual([other]);
    expect(String(mocks.run.mock.calls[0][0])).toContain('coalesce(actor.canBrowseUserDirectory, false)');
    expect(mocks.run.mock.calls[0][1]).toMatchObject({ userId: caller.id, search: 'alice' });
    expect(mocks.run.mock.calls[1][1]).toMatchObject({ userId: trustedCaller.id, search: '' });
    expect(mocks.run.mock.calls[2][1]).toMatchObject({ userId: trustedCaller.id, search: 'alice' });
  });

  it('uses the same exact-email rule in global search while preserving other search buckets', async () => {
    const partialResponse = await fetch(`${baseUrl}/api/chat/search?q=Alice`, {
      headers: { Authorization: authorization },
    });
    const exactResponse = await fetch(`${baseUrl}/api/chat/search?q=${encodeURIComponent('ALICE.OTHER@EXAMPLE.TEST')}`, {
      headers: { Authorization: authorization },
    });

    expect((await partialResponse.json()).contacts).toEqual([]);
    expect((await exactResponse.json()).contacts).toEqual([other]);
    const contactCalls = mocks.run.mock.calls.filter(([cypher]) => String(cypher).includes('contactEmail'));
    expect(contactCalls[0][1]).toMatchObject({ selfOnly: false, contactEmail: '' });
    expect(contactCalls[1][1]).toMatchObject({ selfOnly: false, contactEmail: 'alice.other@example.test' });
  });

  it('uses trusted partial discovery in the contacts bucket of global search', async () => {
    const response = await fetch(`${baseUrl}/api/chat/search?q=Alice`, {
      headers: { Authorization: trustedAuthorization },
    });

    expect((await response.json()).contacts).toEqual([other]);
    const contactCall = mocks.run.mock.calls.find(([cypher]) => String(cypher).includes('contactEmail'));
    expect(String(contactCall?.[0])).toContain('coalesce(actor.canBrowseUserDirectory, false)');
    expect(contactCall?.[1]).toMatchObject({ userId: trustedCaller.id, contactSearch: 'alice' });
  });

  it('normalizes case in the dedicated by-email lookup', async () => {
    mocks.run.mockResolvedValueOnce(resultWith(other));

    const response = await fetch(`${baseUrl}/api/chat/users/by-email/${encodeURIComponent('ALICE.OTHER@EXAMPLE.TEST')}`, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(other);
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining('toLower(u.email) = $email'), {
      email: 'alice.other@example.test',
    });
  });
});
