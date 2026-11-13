import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  emit: vi.fn(),
  to: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ 
      run: mocks.run, 
      close: mocks.close,
      executeWrite: (cb: any) => cb({ run: mocks.run }),
      executeRead: (cb: any) => cb({ run: mocks.run })
    }),
  }),
}));

import authRouter from '../src/routes/auth.js';

describe('PUT /api/auth/me/status', () => {
  let app: express.Express;
  let server: Server;
  let port: number;
  let token: string;

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET','test-secret');
    app = express();
    app.use(express.json());
    // Mock io app setting since we use req.app.get('io') in the route
    app.set('io', {to: mocks.to.mockReturnValue({emit:mocks.emit})});
    app.use('/api/auth', authRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });

    token = jwt.sign({ userId: 'u1', email: 'test@test.com' }, process.env.JWT_SECRET);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates profile status via PUT /me/status', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: () => ({
          id: 'u1',
          name: 'Test',
          profileStatus: { text: 'Working', emoji: '💻', updatedAt: '2024-01-01T00:00:00.000Z' }
        })
      }]
    });
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: () => 'conv1'
      }]
    });

    mocks.run.mockResolvedValueOnce({records:[]}).mockResolvedValueOnce({records:[{get:() => 'peer-2'}]});

    const res = await fetch(`http://localhost:${port}/api/auth/me/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: 'Working', emoji: '💻' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profileStatus.text).toBe('Working');
    expect(body.profileStatus.emoji).toBe('💻');

    expect(mocks.to).toHaveBeenCalledWith(['user:peer-2']);
    expect(mocks.emit).toHaveBeenCalledWith('user:profile-updated',expect.objectContaining({userId:'u1',profileStatus:expect.objectContaining({text:'Working',emoji:'💻'})}));
    const callArgs = mocks.run.mock.calls[0][1];
    expect(callArgs.setProfileStatusText).toBe(true);
    expect(callArgs.profileStatusText).toBe('Working');
    expect(callArgs.setProfileStatusEmoji).toBe(true);
    expect(callArgs.profileStatusEmoji).toBe('💻');
  });

  it('clears profile status via PUT /me/status', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: () => ({
          id: 'u1',
          name: 'Test',
          profileStatus: null
        })
      }]
    });
    mocks.run.mockResolvedValueOnce({
      records: []
    });

    const res = await fetch(`http://localhost:${port}/api/auth/me/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ text: null, emoji: null })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profileStatus).toBeNull();
  });
});
