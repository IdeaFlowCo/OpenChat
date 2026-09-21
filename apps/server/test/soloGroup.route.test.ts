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

describe('solo-started group conversations', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'solo-group-route-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: 'creator', email: 'creator@example.test' },
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

  it('creates a named group with only its creator, then adds a member', async () => {
    const createdConversation = {
      id: 'solo-group',
      title: 'Future crew',
      type: 'group',
      participants: [{ user: { id: 'creator', name: 'Creator' }, role: 'owner' }],
    };
    const expandedConversation = {
      ...createdConversation,
      participants: [
        ...createdConversation.participants,
        { user: { id: 'new-member', name: 'New Member' }, role: 'member' },
      ],
    };

    mocks.run
      // Solo creation skips the other-participant availability query.
      .mockResolvedValueOnce({ records: [{ get: () => createdConversation }] })
      // Adding a member verifies group ownership and target availability.
      .mockResolvedValueOnce({
        records: [{ get: (key: string) => key === 'type' ? 'group' : 'owner' }],
      })
      .mockResolvedValueOnce({ records: [{ get: () => true }] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{ get: () => expandedConversation }] });

    const createResponse = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'group', participantIds: [], title: '  Future crew  ' }),
    });

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toEqual(createdConversation);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][1]).toMatchObject({
      title: 'Future crew',
      type: 'group',
      participants: ['creator'],
      userId: 'creator',
    });

    const addResponse = await fetch(`${baseUrl}/api/chat/conversations/solo-group/participants`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'new-member' }),
    });

    expect(addResponse.status).toBe(201);
    expect(await addResponse.json()).toEqual(expandedConversation);
    expect(mocks.run).toHaveBeenCalledTimes(5);
    expect(mocks.run.mock.calls[3][1]).toMatchObject({
      id: 'solo-group',
      targetId: 'new-member',
    });
  });

  it('keeps an empty participant list invalid for direct conversations', async () => {
    const response = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'direct', participantIds: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'participantIds required' });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
