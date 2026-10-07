import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ scopes: ['read', 'write'], member: true, active: true, run: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({
  run: state.run, close: async () => {},
  executeRead: async (fn: any) => fn({ run: state.run }),
  executeWrite: async (fn: any) => fn({ run: state.run }),
}) }) }));
import contextRoutes from '../src/routes/context.js';
import { evictFromCache } from '../src/middleware/resolveActor.js';

const key = 'oc_context-regression-key';
const secret = '12'.repeat(32);
const iv = Buffer.alloc(12, 1);
const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
const encrypted = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]).toString('hex');
const record = (values: Record<string, any>) => ({ get: (name: string) => values[name] });
const app = express().use(express.json()).use('/api/chat', contextRoutes);
const path = '/api/chat/conversations/room/context';
const post = { text: 'Test context', kind: 'note', clientRequestId: 'request-1' };

beforeEach(() => {
  process.env.OPENCHAT_CONTEXT_LANE = 'true';
  process.env.OC_KEY_ENCRYPTION_SECRET = secret;
  evictFromCache(key.slice(0, 11));
  state.scopes = ['read', 'write']; state.member = true; state.active = true;
  state.run.mockReset().mockImplementation(async (query: string, params: any) => {
    if (query.includes('keyCiphertext AS keyCiphertext')) return { records: [record({ keyCiphertext: encrypted, keyIv: iv.toString('hex'), keyId: 'key-1', ownerUserId: 'owner', scopes: [...state.scopes], expiresAt: null })] };
    if (query.includes('RETURN c.id AS conversationId')) return { records: state.member && state.active && state.scopes.includes(params.scope) ? [record({ conversationId: 'room' })] : [] };
    if (query.includes('CREATE (t:Thought')) return { records: [record({ t: { properties: { ...params, authorId: params.userId, createdAt: params.now, updatedAt: params.now, revision: 1 } } })] };
    return { records: [] };
  });
});
const auth = () => ({ Authorization: `Bearer ${key}` });

describe('normal OpenChat API keys on Context', () => {
  it('reads and posts with the same read/write key, without a special grant', async () => {
    expect((await request(app).get(path).set(auth())).status).toBe(200);
    const response = await request(app).post(path).set(auth()).send(post);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ text: post.text, authorId: 'owner', lane: 'context' });
    expect(state.run.mock.calls.some(([q]) => q.includes('GRANTS_CONTEXT_ACCESS'))).toBe(false);
  });
  it('denies nonmembers and read-only writes', async () => {
    state.member = false;
    expect((await request(app).get(path).set(auth())).status).toBe(403);
    expect((await request(app).post(path).set(auth()).send(post)).status).toBe(403);
    state.member = true; state.scopes = ['read'];
    evictFromCache(key.slice(0, 11));
    expect((await request(app).get(path).set(auth())).status).toBe(200);
    expect((await request(app).post(path).set(auth()).send(post)).status).toBe(403);
  });
  it('rechecks key activity after authentication has been cached', async () => {
    expect((await request(app).get(path).set(auth())).status).toBe(200);
    state.active = false;
    expect((await request(app).get(path).set(auth())).status).toBe(403);
    expect((await request(app).post(path).set(auth()).send(post)).status).toBe(403);
  });
  it.each([{ content: 'chat body', clientRequestId: 'r' }, { text: 123, clientRequestId: 'r' }, { text: 'note' }, { ...post, kind: 'context' }])('returns actionable 400 for malformed context: %j', async body => {
    const response = await request(app).post(path).set(auth()).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBeTruthy();
  });
  it.each([{text:'',expectedRevision:1},{text:'edit',expectedRevision:'1'},{text:'edit',expectedRevision:0},{}])('rejects malformed edits: %j', async body => {
    expect((await request(app).patch(`${path}/post`).set(auth()).send(body)).status).toBe(400);
  });
  it.each(['limit=-1','limit=2x','limit=0','cursor=nonsense','kind=unknown','search=a&search=b'])('rejects malformed listing query: %s', async query => {
    expect((await request(app).get(`${path}?${query}`).set(auth())).status).toBe(400);
  });
  it('does not let an agent configure another key',async()=>{
    expect((await request(app).put('/api/chat/context-agent/preferences').set(auth()).send({keyId:'other',enabled:true})).status).toBe(403);
    expect((await request(app).put('/api/chat/context-agent/preferences').set(auth()).send({enabled:'yes'})).status).toBe(400);
  });

});
