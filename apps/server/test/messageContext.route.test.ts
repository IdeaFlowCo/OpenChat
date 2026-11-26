import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close }) }) }));
import router from '../src/routes/messageContext.js';

describe('message permalink context', () => {
  let server: Server; let base: string;
  const authorization = `Bearer ${jwt.sign({ userId: 'synthetic-viewer', email: 'viewer@example.test' }, 'dev-secret-change-me')}`;
  beforeAll(async () => {
    const app = express(); app.use('/api/chat/messages', router);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => { vi.resetAllMocks(); });
  const get = (id = 'old-message', auth = authorization) => fetch(`${base}/api/chat/messages/${id}/context`, { headers: auth ? { Authorization: auth } : {} });

  it('requires authentication and does not look up a message for anonymous callers', async () => {
    expect((await get('old-message', '')).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('returns exact bounded context even when the message is outside recent history', async () => {
    const conversation = { id: 'old-chat', name: 'Synthetic chat', type: 'group' };
    const messages = [{ id: 'before', content: 'Before', createdAt: '2020-01-01T00:00:00Z' }, { id: 'old-message', content: 'Target', createdAt: '2020-01-01T00:01:00Z' }];
    mocks.run.mockResolvedValueOnce({ records: [{ get: () => conversation }] }).mockResolvedValueOnce({ records: messages.map(message => ({ get: () => message })) });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ conversation, messageId: 'old-message', messages });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    for (const [query, params] of mocks.run.mock.calls) {
      expect(query).toContain('PARTICIPATES_IN');
      expect(query).toContain('conversationId: c.id');
      expect(query).toMatch(/(?:m|source)\.deletedAt IS NULL/);
      expect(params.userId).toBe('synthetic-viewer');
      expect(params.messageId).toBe('old-message');
    }
    expect(mocks.run.mock.calls[1]![0]).toContain('LIMIT 5');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('uses the same unavailable response for deleted, missing and non-member messages', async () => {
    for (const reason of ['deleted', 'missing', 'non-member']) {
      mocks.run.mockResolvedValueOnce({ records: [] });
      const response = await get(reason);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Message unavailable' });
    }
  });
  it('rechecks membership before returning context if access changed between reads', async () => {
    mocks.run.mockResolvedValueOnce({ records: [{ get: () => ({ id: 'old-chat' }) }] }).mockResolvedValueOnce({ records: [] });
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Message unavailable' });
  });
  it('rejects malformed ids before the database and never includes errors or content in a failure response', async () => {
    expect((await get('bad%20id')).status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.run.mockRejectedValue(new Error('synthetic private database detail'));
    const response = await get();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private database detail');
  });
});
