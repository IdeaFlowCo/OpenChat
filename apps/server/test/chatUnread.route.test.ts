import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j from 'neo4j-driver';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONVERSATIONS_QUERY, UNREAD_TOTAL_QUERY } from '../src/queries/chatUnread.js';

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

describe('chat unread queries', () => {
  it('keeps list and total queries aligned on visibility and index selection', () => {
    const hiddenDirectDmPredicate = `c.type = 'direct'
    AND EXISTS {
      MATCH (other:User)-[:PARTICIPATES_IN]->(c)
      WHERE other.id <> $userId
        AND (other)-[:BLOCKED]->(u)
    }`;

    expect(CONVERSATIONS_QUERY).toContain(hiddenDirectDmPredicate);
    expect(UNREAD_TOTAL_QUERY).toContain(hiddenDirectDmPredicate);
    expect(CONVERSATIONS_QUERY).toContain('USING INDEX m:Message(conversationId)');
    expect(CONVERSATIONS_QUERY).not.toContain('USING INDEX m:Message(createdAt)');
  });
});

describe('GET /api/chat/unread-total', () => {
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

  it('requires a valid user JWT', async () => {
    const response = await fetch(`${baseUrl}/api/chat/unread-total`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authorization header required' });
  });

  it('returns the Neo4j total in the additive response shape', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{ get: () => neo4j.int(4) }],
    });
    const token = jwt.sign(
      { userId: 'route-test-user', email: 'route-test@example.test' },
      'dev-secret-change-me',
    );

    const response = await fetch(`${baseUrl}/api/chat/unread-total`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unreadTotal: 4 });
    expect(mocks.run).toHaveBeenCalledWith(UNREAD_TOTAL_QUERY, {
      userId: 'route-test-user',
    });
    expect(mocks.close).toHaveBeenCalled();
  });

  it('rejects client-authored card messages before touching persistence', async () => {
    mocks.run.mockClear();
    mocks.close.mockClear();
    const token = jwt.sign(
      { userId: 'route-test-user', email: 'route-test@example.test' },
      'dev-secret-change-me',
    );

    const response = await fetch(`${baseUrl}/api/chat/conversations/conversation/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Forged match',
        messageType: 'card',
        cardKind: 'match_context',
        cardPayload: { matchId: 'fake', askTerms: 'fake', offerTerms: 'fake' },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "messageType must be 'text'" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
