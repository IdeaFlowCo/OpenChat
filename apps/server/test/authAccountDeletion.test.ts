import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queries: [] as Array<{ query: string; params: Record<string, unknown> }>,
  txRun: vi.fn(async (query: string, params: Record<string, unknown>) => {
    mocks.queries.push({ query, params });
    if (query.includes('RETURN collect(DISTINCT match.id) AS matchIds')) {
      return { records: [{ get: (key: string) => key === 'matchIds' ? ['owned-match'] : undefined }] };
    }
    return { records: [] };
  }),
  close: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      executeWrite: async (callback: (tx: { run: typeof mocks.txRun }) => Promise<void>) => callback({ run: mocks.txRun }),
      close: mocks.close,
    }),
  }),
}));

import authRoutes from '../src/routes/auth.js';

describe('DELETE /api/auth/me social-layer cleanup', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    mocks.queries.length = 0;
    mocks.txRun.mockClear();
    mocks.close.mockClear();
    process.env.JWT_SECRET = 'account-deletion-test-secret';
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('deletes owned social records and shared match nodes without deleting the other intent', async () => {
    const token = jwt.sign({ userId: 'delete-me', email: 'delete@example.test' }, process.env.JWT_SECRET!);
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(204);

    const queries = mocks.queries.map(({ query }) => query.replace(/\s+/g, ' ').trim());
    const indexOf = (text: string) => queries.findIndex((query) => query.includes(text));
    const matchLookup = indexOf('RETURN collect(DISTINCT match.id) AS matchIds');
    const deliveryDelete = indexOf('message.matchContextKey IN $matchIds');
    const matchDelete = indexOf('MATCH (match:AgentMatch) WHERE match.id IN $matchIds');
    const draftDelete = indexOf('OWNS_INTENT_DRAFT');
    const storyDelete = indexOf('OWNS_STORY');
    const intentDelete = queries.findIndex((query, index) => index > matchDelete
      && query.includes('OWNS_INTENT]->(intent:AgentIntent)') && query.includes('DETACH DELETE intent'));
    const preferenceDelete = indexOf('HAS_SOCIAL_PREFERENCE');
    const userDelete = indexOf('DETACH DELETE u');

    expect([matchLookup, deliveryDelete, matchDelete, draftDelete, storyDelete, intentDelete, preferenceDelete, userDelete])
      .not.toContain(-1);
    expect(matchLookup).toBeLessThan(deliveryDelete);
    expect(deliveryDelete).toBeLessThan(matchDelete);
    expect(matchDelete).toBeLessThan(intentDelete);
    expect(storyDelete).toBeLessThan(intentDelete);
    expect(intentDelete).toBeLessThan(userDelete);
    expect(queries[matchLookup]).toContain('User {id: $userId}');
    expect(queries[intentDelete]).toContain('User {id: $userId}');
    expect(queries[intentDelete]).not.toContain('other');
    expect(mocks.queries.every(({ params }) => params.userId === undefined || params.userId === 'delete-me')).toBe(true);
  });
});
