import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
  getDriverForRequest: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import chatRoutes from '../src/routes/chat.js';

describe('chat route block enforcement', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'chat-block-route-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: 'actor', email: 'actor@example.test' },
      process.env.JWT_SECRET,
    )}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockClear();
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('requires a name for a group with no other people', async () => {
    const response = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'group', participantIds: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A group name is required when creating a group without other participants',
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('refuses group creation when a participant is unavailable or blocked', async () => {
    mocks.run.mockResolvedValueOnce({ records: [{ get: () => false }] });

    const response = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'group', participantIds: ['other-1', 'other-2'] }),
    });

    expect(response.status).toBe(404);
    expect(String(mocks.run.mock.calls[0][0])).toContain('[:BLOCKED]');
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('refuses adding a blocked member to a group', async () => {
    mocks.run
      .mockResolvedValueOnce({
        records: [{ get: (key: string) => key === 'type' ? 'group' : 'owner' }],
      })
      .mockResolvedValueOnce({ records: [{ get: () => false }] });

    const response = await fetch(`${baseUrl}/api/chat/conversations/group-1/participants`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'blocked-user' }),
    });

    expect(response.status).toBe(404);
    expect(String(mocks.run.mock.calls[1][0])).toContain('[:BLOCKED]');
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('does not let the REST send fallback bypass a participant block', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{ get: (key: string) => key === 'blockedRelationship' }],
    });

    const response = await fetch(`${baseUrl}/api/chat/conversations/group-1/messages`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, dropped: true });
    const authorizationCypher = String(mocks.run.mock.calls[0][0]);
    expect(authorizationCypher).toContain('[:BLOCKED]');
    expect(authorizationCypher).toContain('other.id <> u.id');
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
