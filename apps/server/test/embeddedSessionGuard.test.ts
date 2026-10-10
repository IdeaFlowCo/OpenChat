import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ run: vi.fn(async () => ({ records: [] })), close: vi.fn(), executeWrite: vi.fn(), executeRead: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
import agentKeys from '../src/routes/agentKeys.js';
import auth from '../src/routes/auth.js';
import webhooks from '../src/routes/webhooks.js';
import push from '../src/routes/push.js';

const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
const embedded = jwt.sign({ userId: 'person', email: 'shared-inbox@ideaflow.invalid', embedded: 'unlinked' }, secret, { expiresIn: '10m' });

describe('embedded Unlinked sessions cannot manage credentials, delivery channels or the account', () => {
  const app = express().use(express.json()).use('/api/agent-keys', agentKeys).use('/api/auth', auth).use('/api/webhooks', webhooks).use('/api/push', push);
  it.each([
    ['post', '/api/agent-keys'], ['get', '/api/agent-keys'], ['get', '/api/agent-keys/k1/reveal'],
    ['patch', '/api/agent-keys/k1'], ['delete', '/api/agent-keys/k1'],
    ['delete', '/api/auth/me'], ['get', '/api/auth/export?range=all'],
    ['post', '/api/webhooks'], ['get', '/api/webhooks'], ['delete', '/api/webhooks/w1'],
    ['post', '/api/push/subscribe'], ['delete', '/api/push/subscribe'], ['post', '/api/push/register-native'], ['delete', '/api/push/register-native'],
  ] as const)('%s %s -> 403', async (method, path) => {
    const res = await request(app)[method](path).auth(embedded, { type: 'bearer' }).send({ name: 'escalation', scopes: ['read'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/directly/);
  });
  it('no database work happens for a refused embedded request', () => expect(db.run).not.toHaveBeenCalled());
});
