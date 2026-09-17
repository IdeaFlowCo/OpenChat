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
}));

import authRoutes from '../src/routes/auth.js';

describe('PATCH /api/auth/me discovery settings', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'profile-discovery-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: 'profile-user', email: 'profile@example.test' },
      process.env.JWT_SECRET,
    )}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockClear();
    mocks.run.mockResolvedValue({
      records: [{
        get: () => ({
          id: 'profile-user',
          email: 'profile@example.test',
          name: 'Profile User',
          discoveryMode: 'email_only',
        }),
      }],
    });
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('persists a valid discovery mode with the existing profile update', async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'PATCH',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discoveryMode: 'email_only' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ discoveryMode: 'email_only' });
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining('u.discoveryMode'), expect.objectContaining({
      userId: 'profile-user',
      discoveryMode: 'email_only',
    }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('rejects an unknown discovery mode before opening a database session', async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'PATCH',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discoveryMode: 'public_email' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'discoveryMode must be name, email_only, or hidden' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('rejects email-like display names before opening a database session', async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'PATCH',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private@example.test' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'name must not contain an email address' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
