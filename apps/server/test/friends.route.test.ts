import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ changeFriend: vi.fn(), getFriendStatus: vi.fn(), listFriends: vi.fn() }));
vi.mock('../src/services/friends.js', () => ({
  FriendError: class FriendError extends Error { constructor(public status: number, message: string) { super(message); } },
  changeFriend: mocks.changeFriend,
  getFriendStatus: mocks.getFriendStatus,
  listFriends: mocks.listFriends,
}));
import friendsRoutes from '../src/routes/friends.js';

describe('friend routes', () => {
  let server: Server;
  let baseUrl: string;
  const token = () => `Bearer ${jwt.sign({ userId: 'alice', email: 'alice@example.test' }, process.env.JWT_SECRET!)}`;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'friend-route-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/friends', friendsRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('requires a signed-in actor and ignores actor ids in the request body', async () => {
    expect((await fetch(`${baseUrl}/api/friends`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/friends/users/bob/request`, { method: 'POST' })).status).toBe(401);
    mocks.changeFriend.mockResolvedValue({ userId: 'bob', state: 'outgoing', updatedAt: null });
    const response = await fetch(`${baseUrl}/api/friends/users/bob/request`, {
      method: 'POST', headers: { Authorization: token(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'mallory', requestedTo: 'alice' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.changeFriend).toHaveBeenCalledWith('alice', 'bob', 'request', 'profile');
  });

  it('routes recipient actions through the same service', async () => {
    mocks.changeFriend.mockResolvedValue({ userId: 'bob', state: 'friends', updatedAt: null });
    const response = await fetch(`${baseUrl}/api/friends/users/bob/accept`, { method: 'POST', headers: { Authorization: token() } });
    expect(response.status).toBe(200);
    expect(mocks.changeFriend).toHaveBeenCalledWith('alice', 'bob', 'accept');
  });
});
