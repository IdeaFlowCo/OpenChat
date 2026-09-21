import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

describe('GET /api/chat/invites/:token (public preview)', () => {
  let server: Server;
  let baseUrl: string;

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
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('returns safe preview fields for a valid token without authentication', async () => {
    // Mock the invite lookup
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: (key: string) => {
          if (key === 'inv') return { properties: { token: 'valid-token', expiresAt: new Date(Date.now() + 86400000).toISOString(), usesLeft: 5 } };
          if (key === 'conversationId') return 'c-123';
          if (key === 'conversationTitle') return 'Sailing Buddies';
          return null;
        }
      }],
    });
    // Mock the member count query
    mocks.run.mockResolvedValueOnce({
      records: [{ get: () => ({ toNumber: () => 42 }) }],
    });

    const response = await fetch(`${baseUrl}/api/chat/invites/valid-token`);
    expect(response.status).toBe(200);
    const body = await response.json();
    
    expect(body.conversationId).toBe('c-123');
    expect(body.conversationTitle).toBe('Sailing Buddies');
    expect(body.memberCount).toBe(42);
    // Should NOT expose messages or participants array
    expect(body.messages).toBeUndefined();
    expect(body.participants).toBeUndefined();
  });

  it('returns 404 for an unknown token', async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    const response = await fetch(`${baseUrl}/api/chat/invites/unknown-token`);
    expect(response.status).toBe(404);
  });

  it('returns 410 for an expired token', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: (key: string) => {
          if (key === 'inv') return { properties: { token: 'expired-token', expiresAt: new Date(Date.now() - 86400000).toISOString(), usesLeft: 5 } };
          if (key === 'conversationId') return 'c-123';
          if (key === 'conversationTitle') return 'Sailing Buddies';
          return null;
        }
      }],
    });

    const response = await fetch(`${baseUrl}/api/chat/invites/expired-token`);
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.error).toBe('This invite has expired');
  });
});
