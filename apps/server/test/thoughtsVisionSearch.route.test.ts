import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), search: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: async () => {} }) }) }));
vi.mock('../src/services/visionBridge.js', async (original) => ({ ...(await original<typeof import('../src/services/visionBridge.js')>()), searchVision: mocks.search }));
import thoughts from '../src/routes/thoughts.js';
import { buildTools } from '../src/services/assistant.js';

const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
const human = jwt.sign({ userId: 'alice', email: 'a@example.test' }, secret);
const embedded = jwt.sign({ userId: 'alice', email: 'vision-session@ideaflow.invalid', embedded: 'vision' }, secret);
const app = express().use(express.json()).use('/api/thoughts', thoughts);
const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

describe('GET /api/thoughts/vision-search', () => {
  beforeEach(() => { mocks.run.mockReset(); mocks.search.mockReset(); });
  it('searches as the signed-in owner’s own Ideaflow identity', async () => {
    mocks.run.mockResolvedValue({ records: [record({ issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub' })] });
    mocks.search.mockResolvedValue({ status: 'ok', rows: [], nextCursor: null });
    const res = await request(app).get('/api/thoughts/vision-search?q=idea').auth(human, { type: 'bearer' });
    expect(res.status).toBe(200); expect(res.body).toEqual({ status: 'ok', rows: [], nextCursor: null });
    expect(mocks.search).toHaveBeenCalledWith('alice', { issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub' }, 'idea', 'openchat', null);
  });
  it('answers account_link_required for an account without an Ideaflow identity', async () => {
    mocks.run.mockResolvedValue({ records: [record({ issuer: null, subject: null })] });
    const res = await request(app).get('/api/thoughts/vision-search?q=idea&chip=all').auth(human, { type: 'bearer' });
    expect(res.body).toMatchObject({ status: 'unavailable', code: 'account_link_required' });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it.each(['', '?q=', '?q=x&chip=everyone', '?q=x&cursor=%%%', `?q=${'x'.repeat(201)}`])('rejects invalid input %s', async (query) => {
    expect((await request(app).get('/api/thoughts/vision-search' + query).auth(human, { type: 'bearer' })).status).toBe(400);
  });
  it('refuses embedded partner sessions and anonymous callers', async () => {
    expect((await request(app).get('/api/thoughts/vision-search?q=x').auth(embedded, { type: 'bearer' })).status).toBe(403);
    expect((await request(app).get('/api/thoughts/vision-search?q=x')).status).toBe(401);
  });
});

describe('assistant stream_read', () => {
  it('is offered in the owner’s universal DM and withheld from conversation-scoped turns', () => {
    expect(buildTools({ kind: 'universal', conversationId: 'dm' }).map(t => t.name)).toContain('stream_read');
    expect(buildTools({ kind: 'conversation', conversationId: 'group' }).map(t => t.name)).not.toContain('stream_read');
  });
});
