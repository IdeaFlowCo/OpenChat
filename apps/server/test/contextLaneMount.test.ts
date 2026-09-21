import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
}));

const mockSession = {
  run: mocks.run,
  close: mocks.close,
  executeRead: vi.fn(async (cb) => cb({ run: mocks.run })),
  executeWrite: vi.fn(async (cb) => cb({ run: mocks.run })),
};

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => mockSession,
  }),
  getDriverForRequest: () => ({
    session: () => mockSession,
  }),
}));

import chatRoutes from '../src/routes/chat.js';
import contextRoutes from '../src/routes/context.js';

describe('context lane mount routing', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'context-mount-test-secret';
    const app = express();
    app.use(express.json());
    // This is the order in index.ts that caused the regression
    app.use('/api/chat', contextRoutes);
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
    mockSession.executeRead.mockClear();
    mockSession.executeWrite.mockClear();
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    delete process.env.OPENCHAT_CONTEXT_LANE;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('allows core chat routes but 404s context routes when flag is OFF', async () => {
    // Flag OFF
    process.env.OPENCHAT_CONTEXT_LANE = 'false';

    // Core chat route should not return 404 from context gate
    // Mock the DB for chat route (get conversations)
    mocks.run.mockResolvedValueOnce({ records: [] });
    const conversationsRes = await fetch(`${baseUrl}/api/chat/conversations`, {
      headers: { Authorization: authorization },
    });
    // It should hit chatRoutes and return a normal response (not 404 Context Lane feature is not enabled)
    const conversationsData = await conversationsRes.json();
    expect(conversationsRes.status).toBe(200);
    expect(Array.isArray(conversationsData)).toBe(true);

    // Context route should return 404
    const contextRes = await fetch(`${baseUrl}/api/chat/conversations/123/context`, {
      headers: { Authorization: authorization },
    });
    expect(contextRes.status).toBe(404);
    expect(await contextRes.json()).toEqual({ error: 'Context Lane feature is not enabled' });
  });

  it('allows context routes when flag is ON', async () => {
    // Flag ON
    process.env.OPENCHAT_CONTEXT_LANE = 'true';

    // Mock Context Lane listContextPosts db response
    mocks.run.mockResolvedValueOnce({
      records: [
        { get: (key: string) => key === 'hasAccess' ? true : undefined } // checkContextReadAccess
      ]
    });
    mocks.run.mockResolvedValueOnce({ records: [] }); // listContextPosts query
    
    const contextRes = await fetch(`${baseUrl}/api/chat/conversations/123/context`, {
      headers: { Authorization: authorization },
    });
    
    // It should proceed past the 404 gate. (Returns 200 with an empty list)
    expect(contextRes.status).toBe(200);
    const data = await contextRes.json();
    expect(Array.isArray(data.posts)).toBe(true);
  });
});