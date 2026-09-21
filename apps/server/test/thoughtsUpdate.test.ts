import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j from 'neo4j-driver';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));

const mocks = {
  run: vi.fn(),
  close: vi.fn(),
};

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: mocks.run,
      close: mocks.close,
    }),
  }),
}));

import thoughtsRouter from '../src/routes/thoughts.js';

describe('PATCH /api/thoughts/:id', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.set('io', { to: mockTo });
    app.use(express.json());
    app.use('/api/thoughts', thoughtsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('updates a thought and emits thought:updated via socket.io', async () => {
    const token = jwt.sign({ userId: 'user-1', email: 'user1@example.test' }, 'dev-secret-change-me');
    
    // Mock the session.run calls for the PATCH endpoint
    mocks.run
      // 1. The main update query
      .mockResolvedValueOnce({
        records: [
          {
            get: () => ({
              id: 'thought-1',
              text: 'updated text',
              kind: 'fact',
              status: 'none',
              createdAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:00.000Z')),
              updatedAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:05:00.000Z')),
              tags: [],
            }),
          },
        ],
      })
      // 2. The query finding conversations the thought is pinned/shared in
      .mockResolvedValueOnce({
        records: [
          { get: () => 'conv-1' }
        ]
      });

    const response = await fetch(`${baseUrl}/api/thoughts/thought-1`, {
      method: 'PATCH',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ text: 'updated text' })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toBe('updated text');

    // Check socket emissions
    expect(mockTo).toHaveBeenCalledWith('user:user-1');
    expect(mockTo).toHaveBeenCalledWith('conversation:conv-1');
    expect(mockEmit).toHaveBeenCalledWith('thought:updated', expect.objectContaining({
      thought: expect.objectContaining({ text: 'updated text' })
    }));
  });
});