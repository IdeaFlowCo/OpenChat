import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), close: vi.fn(), actor: 'human', enabled: true }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ close: mocks.close }) }) }));
vi.mock('../src/config/features.js', () => ({ isContextLaneEnabled: () => mocks.enabled }));
vi.mock('../src/services/conversationContent.js', () => ({ listConversationContent: mocks.read }));
vi.mock('../src/lib/ideaflowConnector.js', () => ({ getConnectorPrincipal: () => mocks.actor === 'connector' ? { id: 'owner', scopes: ['openchat:read'] } : undefined }));
vi.mock('../src/middleware/resolveActor.js', () => ({ resolveActor: (req: any, res: any, next: any) => {
  if (mocks.actor === 'anonymous') { res.status(401).json({ error: 'Authentication required' }); return; }
  req.user = { userId: 'owner', ...(mocks.actor === 'embed' ? { embedded: 'unlinked' } : {}) };
  if (mocks.actor === 'key' || mocks.actor === 'write-key') { req.agentKeyId = 'key'; req.agentScopes = mocks.actor === 'key' ? ['read'] : ['write']; }
  if (mocks.actor === 'connector') req.agentScopes = ['openchat:read'];
  if (mocks.actor === 'delegation') req.connectorDelegation = {};
  next();
} }));
import router from '../src/routes/conversationContent.js';
const app = express(); app.use('/api/chat', router);
const path = '/api/chat/conversations/room/content';
beforeEach(() => { vi.clearAllMocks(); mocks.actor = 'human'; mocks.enabled = true; mocks.read.mockResolvedValue({ items: [] }); });
it('direct human reads may include their own private entries, with no-store', async () => {
  const response = await request(app).get(path); expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(mocks.read.mock.calls[0][3].includePrivate).toBe(true);
});
it('keys, connectors, delegated calls and embedded sessions never request private projections', async () => {
  for (const actor of ['key', 'connector', 'delegation', 'embed']) { mocks.actor = actor; expect((await request(app).get(path+'?includePrivate=true')).status).toBe(200); expect(mocks.read.mock.calls.at(-1)![3].includePrivate).toBe(false); }
});
it('rejects unauthenticated requests and keys without read scope before reading data', async () => {
  mocks.actor = 'anonymous'; expect((await request(app).get(path)).status).toBe(401);
  mocks.actor = 'write-key'; expect((await request(app).get(path)).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
});
it('rejects malformed query values before any database read', async () => {
  expect((await request(app).get(path+'?filter=context&filter=stream')).status).toBe(400);
  expect((await request(app).get(path+'?limit=1.5')).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});

it('keeps Stream reachable with Context off and preserves private actor boundaries', async () => {
  mocks.enabled = false; mocks.read.mockResolvedValue({ items: [], contextAvailable: false });
  for (const actor of ['human', 'key', 'connector', 'delegation', 'embed']) {
    mocks.actor = actor;
    const response = await request(app).get(path + '?filter=all');
    expect(response.status).toBe(200); expect(response.body.contextAvailable).toBe(false);
    expect(mocks.read.mock.calls.at(-1)![3]).toMatchObject({ contextAvailable: false, includePrivate: actor === 'human' });
  }
});
