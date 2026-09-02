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

function resultWith(user: typeof caller | typeof other | null) {
  return {
    records: user ? [{ get: () => user }] : [],
  };
}

describe('private contact discovery routes', () => {
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
    mocks.run.mockResolvedValue({ records: [] });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('returns only the caller for an empty contact query', async () => {
    mocks.run.mockResolvedValue(resultWith(caller));

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
    mocks.run.mockResolvedValue(resultWith(caller));

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
    mocks.run.mockResolvedValue(resultWith(other));

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

  it('lets a trusted directory caller browse and use partial name search', async () => {
    mocks.run.mockResolvedValue(resultWith(other));

    const browseResponse = await fetch(`${baseUrl}/api/chat/contacts`, {
      headers: { Authorization: authorization },
    });
    const partialResponse = await fetch(`${baseUrl}/api/chat/contacts?q=Alice`, {
      headers: { Authorization: authorization },
    });

    expect(await browseResponse.json()).toEqual([other]);
    expect(await partialResponse.json()).toEqual([other]);
    expect(String(mocks.run.mock.calls[0][0])).toContain('coalesce(actor.canBrowseUserDirectory, false)');
    expect(mocks.run.mock.calls[0][1]).toMatchObject({ search: '' });
    expect(mocks.run.mock.calls[1][1]).toMatchObject({ search: 'alice' });
  });

  it('uses the same exact-email rule in global search while preserving other search buckets', async () => {
    mocks.run.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('contactEmail')) {
        return params.contactEmail === 'alice.other@example.test'
          ? resultWith(other)
          : resultWith(null);
      }
      return { records: [] };
    });

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
    mocks.run.mockImplementation(async (cypher: string) => {
      return cypher.includes('contactEmail') ? resultWith(other) : { records: [] };
    });

    const response = await fetch(`${baseUrl}/api/chat/search?q=Alice`, {
      headers: { Authorization: authorization },
    });

    expect((await response.json()).contacts).toEqual([other]);
    const contactCall = mocks.run.mock.calls.find(([cypher]) => String(cypher).includes('contactEmail'));
    expect(String(contactCall?.[0])).toContain('coalesce(actor.canBrowseUserDirectory, false)');
    expect(contactCall?.[1]).toMatchObject({ contactSearch: 'alice' });
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
