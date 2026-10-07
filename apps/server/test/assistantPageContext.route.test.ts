import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn(), ensure: vi.fn(), post: vi.fn(), trigger: vi.fn(), scopes: ['read', 'write'] }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: async () => {} }) }) }));
vi.mock('../src/services/assistantPageContext.js', async () => ({ ...(await vi.importActual('../src/services/assistantPageContext.js')), resolvePageContext: mocks.resolve }));
vi.mock('../src/services/assistant.js', () => ({ ensureAssistantUser: vi.fn(), ensureAssistantConversation: mocks.ensure, postMessageAs: mocks.post, ASSISTANT_USER_ID: 'assistant' }));
vi.mock('../src/services/assistantTrigger.js', () => ({ maybeTriggerAssistant: mocks.trigger }));
vi.mock('../src/services/directConversation.js', () => ({ ensureDirectConversation: vi.fn() }));
import assistantRoutes from '../src/routes/assistant.js';
import { evictFromCache } from '../src/middleware/resolveActor.js';
import { PrivateGraphError } from '../src/services/privateGraph.js';

const app = express().use(express.json()).use('/api/assistant', assistantRoutes);
const endpoint = '/api/assistant/context-message';
const io = {}; app.set('io', io);
const key = 'oc_page-context-route-test';
const encryptionSecret = '34'.repeat(32);
const iv = Buffer.alloc(12, 2);
const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encryptionSecret, 'hex'), iv);
const ciphertext = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]).toString('hex');
const body = { question: ' What remains open? ', context: { kind: 'conversation', id: 'source-room', label: 'Client title', includePrivate: true } };
const userAuth = () => `Bearer ${jwt.sign({ userId: 'alice', email: 'alice@example.test' }, process.env.JWT_SECRET!)}`;
const send = (auth = userAuth(), payload: Record<string, unknown> = body) => request(app).post(endpoint).set('Authorization', auth).send(payload);

beforeEach(() => {
  vi.clearAllMocks(); process.env.JWT_SECRET = 'page-context-route-secret'; process.env.OC_KEY_ENCRYPTION_SECRET = encryptionSecret;
  evictFromCache(key.slice(0, 11)); mocks.scopes = ['read', 'write'];
  mocks.run.mockImplementation(async (query: string) => ({ records: query.includes('keyCiphertext AS keyCiphertext') ? [{ get: (name: string) => ({ keyCiphertext: ciphertext, keyIv: iv.toString('hex'), keyId: 'key-1', ownerUserId: 'alice', expiresAt: null, scopes: mocks.scopes } as Record<string, unknown>)[name] }] : [] }));
  mocks.resolve.mockResolvedValue({ page: 'Conversation', id: 'source-room', title: 'Authoritative title', messages: [{ text: 'Owner-readable context' }] });
  mocks.ensure.mockResolvedValue('alice-private-assistant-dm'); mocks.post.mockResolvedValue({ id: 'message-1' });
});

describe('POST assistant/context-message authenticated boundary', () => {
  it('requires valid authentication before resolving any page', async () => {
    expect((await request(app).post(endpoint).send(body)).status).toBe(401);
    expect((await send('Bearer invalid')).status).toBe(401);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([[], ['read'], ['write']])('denies agent scopes %j before accessing context', async scopes => {
    mocks.scopes = scopes;
    expect((await send(`Bearer ${key}`)).status).toBe(404);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each(['jwt', 'agent'])('uses authenticated owner and posts only to private assistant DM for %s', async authKind => {
    const response = await send(authKind === 'agent' ? `Bearer ${key}` : userAuth(), { ...body, ownerId: 'mallory', userId: 'mallory', conversationId: 'source-room' });
    expect(response.status).toBe(201); expect(response.body).toEqual({ conversationId: 'alice-private-assistant-dm' });
    expect(mocks.resolve).toHaveBeenCalledWith('alice', body.context);
    expect(mocks.ensure).toHaveBeenCalledWith('alice', io);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [postedIo, owner, destination, text, context] = mocks.post.mock.calls[0];
    expect([postedIo, owner, destination]).toEqual([io, 'alice', 'alice-private-assistant-dm']);
    expect(text).toBe('What remains open?'); expect(context.title).toBe('Authoritative title'); expect(context.messages).toEqual([{ text: 'Owner-readable context' }]); expect(text).not.toContain('Owner-readable context');
    expect(mocks.trigger).toHaveBeenCalledWith({ senderId: 'alice', conversationId: 'alice-private-assistant-dm', io });
  });
  it('does not create a DM or post when authoritative page access is denied', async () => {
    mocks.resolve.mockRejectedValue(new PrivateGraphError(404, 'Conversation unavailable'));
    expect((await send()).status).toBe(404);
    expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.trigger).not.toHaveBeenCalled();
  });
  it.each([{ ...body, question: '' }, { ...body, question: 'x'.repeat(4001) }, { ...body, context: { kind: 'thing', label: 'Missing id' } }])('rejects malformed inputs before accessing private context', async payload => {
    expect((await send(userAuth(), payload)).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
});
