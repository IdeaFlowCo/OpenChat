import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j from 'neo4j-driver';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import thoughtsRouter from '../src/routes/thoughts.js';

describe('GET /api/thoughts/tags/suggestions', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/thoughts', thoughtsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: 'user-1', email: 'user1@example.test' },
      'dev-secret-change-me',
    )}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockReset();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('returns ranked, source-labelled suggestions for a case-insensitive prefix', async () => {
    mocks.run
      .mockResolvedValueOnce({ records: [{ get: () => 'conversation-1' }] })
      .mockResolvedValueOnce({
        records: [
          {
            get: () => ({
              tag: 'decision',
              source: 'both',
              ownCount: neo4j.int(3),
              chatCount: neo4j.int(2),
              lastUsedAt: neo4j.types.DateTime.fromStandardDate(
                new Date('2026-09-20T10:00:00.000Z'),
              ),
            }),
          },
          {
            get: () => ({
              tag: 'design',
              source: 'chat',
              ownCount: neo4j.int(0),
              chatCount: neo4j.int(1),
              lastUsedAt: neo4j.types.DateTime.fromStandardDate(
                new Date('2026-09-19T10:00:00.000Z'),
              ),
            }),
          },
        ],
      });

    const response = await fetch(
      `${baseUrl}/api/thoughts/tags/suggestions?conversationId=conversation-1&q=%23De&limit=8`,
      { headers: { Authorization: authorization } },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    expect(body).toEqual([
      {
        tag: 'decision',
        source: 'both',
        ownCount: 3,
        chatCount: 2,
        lastUsedAt: expect.any(String),
      },
      {
        tag: 'design',
        source: 'chat',
        ownCount: 0,
        chatCount: 1,
        lastUsedAt: expect.any(String),
      },
    ]);
    expect(new Date(String(body[0].lastUsedAt)).toISOString()).toBe('2026-09-20T10:00:00.000Z');

    const [cypher, params] = mocks.run.mock.calls[1] as [string, Record<string, unknown>];
    expect(params).toMatchObject({
      userId: 'user-1',
      conversationId: 'conversation-1',
      prefix: 'de',
    });
    expect(cypher).toContain('author.id <> caller.id');
    expect(cypher).toContain('m.conversationId = $conversationId');
    expect(cypher).toContain('ORDER BY (ownCount + chatCount) DESC, lastUsedAt DESC');
  });

  it('does not reveal suggestions outside conversations the caller participates in', async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });

    const response = await fetch(
      `${baseUrl}/api/thoughts/tags/suggestions?conversationId=private-conversation&q=de`,
      { headers: { Authorization: authorization } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Conversation not found' });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('rejects prefixes that cannot be stored by hashtag extraction', async () => {
    const response = await fetch(
      `${baseUrl}/api/thoughts/tags/suggestions?conversationId=conversation-1&q=two_words`,
      { headers: { Authorization: authorization } },
    );

    expect(response.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
