import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close }) }),
}));

import chatRoutes from '../src/routes/chat.js';

const TOKEN = 'existing-invite-token';
const invite = { token: TOKEN, expiresAt: '2026-12-01T00:00:00Z', usesLeft: 5, createdAt: '2026-09-30T00:00:00Z' };
const ownerResult = { records: [{ get: (key: string) => key === 'type' ? 'group' : 'owner' }] };
const inviteResult = { records: [{ get: () => ({ properties: invite }) }] };

describe('group invite links', () => {
  let server: Server;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'invite-link-route-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    authorization = `Bearer ${jwt.sign({ userId: 'owner', email: 'owner@example.test' }, process.env.JWT_SECRET)}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it.each([
    ['chat.globalbr.ai', 'https://chat.globalbr.ai'],
    ['chat.ideaflow.app', 'https://chat.ideaflow.app'],
  ])('returns %s links for new, reused, and listed invites', async (host, origin) => {
    const endpoint = '/api/chat/conversations/group-1/invites';

    mocks.run.mockResolvedValueOnce(ownerResult).mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] });
    const created = await request(server).post(endpoint).set('Host', host).set('Authorization', authorization).send({});
    expect(created.status).toBe(201);
    const createdBody = created.body;
    expect(createdBody.url).toBe(`${origin}/i/${createdBody.token}`);

    mocks.run.mockReset().mockResolvedValueOnce(ownerResult).mockResolvedValueOnce(inviteResult);
    const reused = await request(server).post(endpoint).set('Host', host).set('Authorization', authorization).send({});
    expect(reused.status).toBe(200);
    expect(reused.body.url).toBe(`${origin}/i/${TOKEN}`);

    mocks.run.mockReset().mockResolvedValueOnce(ownerResult).mockResolvedValueOnce(inviteResult);
    const listed = await request(server).get(endpoint).set('Host', host).set('Authorization', authorization);
    expect(listed.status).toBe(200);
    expect(listed.body[0].url).toBe(`${origin}/i/${TOKEN}`);
  });
});
