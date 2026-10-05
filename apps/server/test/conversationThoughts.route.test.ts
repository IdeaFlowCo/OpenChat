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

describe('GET /api/thoughts/conversation/:conversationId', () => {
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

  it('returns full chat-scoped thoughts when q is omitted', async () => {
    const token = jwt.sign({ userId: 'user-1', email: 'user1@example.test' }, 'dev-secret-change-me');

    // 1. Participant check
    mocks.run.mockResolvedValueOnce({
      records: [{ get: () => 'conv-1' }],
    });

    // 2. Pinned thoughts query
    mocks.run.mockResolvedValueOnce({
      records: [
        {
          get: () => ({
            id: 'pinned-1',
            text: 'pinned note for conv-1',
            kind: 'fact',
            status: 'none',
            createdAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:00.000Z')),
            tags: ['pinned'],
            pinned: true,
          }),
        },
      ],
    });

    // 3. FromChat thoughts query
    mocks.run.mockResolvedValueOnce({
      records: [
        {
          get: () => ({
            id: 'chat-1',
            text: 'captured thought #idea',
            kind: 'idea',
            status: 'none',
            createdAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T11:00:00.000Z')),
            tags: ['idea'],
            pinned: false,
          }),
        },
      ],
    });

    const response = await fetch(`${baseUrl}/api/thoughts/conversation/conv-1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pinned).toHaveLength(1);
    expect(body.pinned[0].text).toBe('pinned note for conv-1');
    expect(body.fromChat).toHaveLength(1);
    expect(body.fromChat[0].text).toBe('captured thought #idea');

    // Verify params passed to cypher did not include q
    expect(mocks.run).toHaveBeenNthCalledWith(2, expect.stringContaining('PINNED_IN'), {
      userId: 'user-1',
      conversationId: 'conv-1',
      q: undefined,
    });
    expect(mocks.run).toHaveBeenNthCalledWith(3, expect.stringContaining('FROM_MESSAGE'), {
      userId: 'user-1',
      conversationId: 'conv-1',
      q: undefined,
    });
  });

  it('filters chat-scoped thoughts by q search query', async () => {
    const token = jwt.sign({ userId: 'user-1', email: 'user1@example.test' }, 'dev-secret-change-me');

    // 1. Participant check
    mocks.run.mockResolvedValueOnce({
      records: [{ get: () => 'conv-1' }],
    });

    // 2. Pinned thoughts query with search
    mocks.run.mockResolvedValueOnce({
      records: [
        {
          get: () => ({
            id: 'pinned-1',
            text: 'matching meeting note',
            kind: 'fact',
            status: 'none',
            createdAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:00.000Z')),
            tags: ['meeting'],
            pinned: true,
          }),
        },
      ],
    });

    // 3. FromChat thoughts query with search
    mocks.run.mockResolvedValueOnce({
      records: [],
    });

    const response = await fetch(`${baseUrl}/api/thoughts/conversation/conv-1?q=meeting`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pinned).toHaveLength(1);
    expect(body.pinned[0].text).toBe('matching meeting note');
    expect(body.fromChat).toHaveLength(0);

    // Verify q parameter was supplied to both Cypher queries
    expect(mocks.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('toLower($q)'),
      expect.objectContaining({ conversationId: 'conv-1', q: 'meeting' })
    );
    expect(mocks.run).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('toLower($q)'),
      expect.objectContaining({ userId: 'user-1', conversationId: 'conv-1', q: 'meeting' })
    );
  });

  it('rejects access if user is not a participant of the conversation', async () => {
    const token = jwt.sign({ userId: 'user-99', email: 'user99@example.test' }, 'dev-secret-change-me');

    // Participant check returns empty
    mocks.run.mockResolvedValueOnce({ records: [] });

    const response = await fetch(`${baseUrl}/api/thoughts/conversation/secret-conv`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
  });
});
