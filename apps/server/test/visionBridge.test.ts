import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), executeWrite: vi.fn(), ensure: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
vi.mock('../src/services/assistant.js', () => ({ ensureAssistantConversation: db.ensure }));
import router from '../src/routes/visionBridge.js';
import { connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import { issueConnectorOperation } from '../src/lib/ideaflowConnector.js';
import {
  enqueueVisionReply, isReservedUsername, parseMessageProvenance, replyBackoff, resetVisionSearchState, runVisionReplyOnce,
  searchVision, decodeCursor, encodeCursor, RESERVED_USERNAMES,
} from '../src/services/visionBridge.js';
import { connectVision } from '../src/services/visionSave.js';

const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });
const secret = 'v'.repeat(40);
const jwtKey = 'test-jwt-key';
const identity = { issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub', name: 'Alice' };
const app = express().use(express.json()).use('/api', connectorOperationGuard).use('/api', router);
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('VISION_MESSAGING_SECRET', secret); vi.stubEnv('JWT_SECRET', jwtKey); });
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/vision/session', () => {
  it('mints a 10-minute embedded:vision session for the existing linked account', async () => {
    db.run.mockResolvedValue({ records: [record({ id: 'alice', name: 'Alice', pending: false })] });
    const reply = await request(app).post('/api/vision/session').auth(secret, { type: 'bearer' }).send(identity);
    expect(reply.status).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body.user).toEqual({ userId: 'alice', name: 'Alice', email: 'vision-session@ideaflow.invalid' });
    const claims = jwt.verify(reply.body.token, jwtKey) as jwt.JwtPayload;
    expect(claims.userId).toBe('alice'); expect(claims.embedded).toBe('vision'); expect(claims.exp! - claims.iat!).toBe(600);
    expect(db.run.mock.calls[0][1]).toEqual({ issuer: identity.issuer, subject: 'alice-sub' });
    expect(db.run.mock.calls[0][0]).not.toMatch(/MERGE|CREATE/);
  });
  it.each([
    ['no linked account', []],
    ['an ambiguous identity', [record({ id: 'a', pending: false }), record({ id: 'b', pending: false })]],
    ['a pending shared inbox (never signed in)', [record({ id: 'inbox', pending: true })]],
  ])('refuses %s with 409 account_link_required and creates nothing', async (_label, records) => {
    db.run.mockResolvedValue({ records });
    const reply = await request(app).post('/api/vision/session').auth(secret, { type: 'bearer' }).send(identity);
    expect(reply.status).toBe(409); expect(reply.body).toEqual({ error: 'account_link_required' });
  });
  it.each([
    [undefined, undefined, identity, 401], ['wrong-secret-'.repeat(4), undefined, identity, 401],
    [secret, 'https://vision.ideaflow.app', identity, 403],
    [secret, undefined, { ...identity, userId: 'victim' }, 400],
    [secret, undefined, { ...identity, issuer: 'https://evil.invalid' }, 400],
    [secret, undefined, { ...identity, subject: '' }, 400],
    [secret, undefined, { ...identity, subject: 'a\nb' }, 400],
  ])('rejects unauthenticated/browser/forged identity requests %#', async (key, origin, body, status) => {
    let req = request(app).post('/api/vision/session');
    if (key) req = req.auth(key as string, { type: 'bearer' });
    if (origin) req = req.set('Origin', origin as string);
    expect((await req.send(body)).status).toBe(status); expect(db.run).not.toHaveBeenCalled();
  });
  it('is unavailable without a strong secret', async () => {
    vi.stubEnv('VISION_MESSAGING_SECRET', 'short');
    expect((await request(app).post('/api/vision/session').auth('short', { type: 'bearer' }).send(identity)).status).toBe(503);
  });
});

describe('GET /api/vision/targets/resolve', () => {
  const visionSession = () => jwt.sign({ userId: 'alice', email: 'vision-session@ideaflow.invalid', embedded: 'vision' }, jwtKey);
  it('resolves @agent to the caller’s own assistant DM for a Vision session', async () => {
    db.ensure.mockResolvedValue('dm-alice-assistant');
    const reply = await request(app).get('/api/vision/targets/resolve?handle=@Agent').auth(visionSession(), { type: 'bearer' });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ handle: 'agent', kind: 'agent', displayName: 'Your agent', conversationId: 'dm-alice-assistant' });
    expect(db.ensure).toHaveBeenCalledWith('alice', undefined);
  });
  it('resolves for a unified-connector principal', async () => {
    db.ensure.mockResolvedValue('dm-bob');
    const path = '/api/vision/targets/resolve?handle=agent';
    const token = issueConnectorOperation('bob', { method: 'GET', path }, ['openchat:write']);
    const reply = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    expect(reply.status).toBe(200); expect(reply.body.conversationId).toBe('dm-bob');
    expect(db.ensure).toHaveBeenCalledWith('bob', undefined);
  });
  it('refuses ordinary sessions and unknown handles', async () => {
    const direct = jwt.sign({ userId: 'alice', email: 'a@example.test' }, jwtKey);
    expect((await request(app).get('/api/vision/targets/resolve?handle=agent').auth(direct, { type: 'bearer' })).status).toBe(403);
    expect((await request(app).get('/api/vision/targets/resolve?handle=bob').auth(visionSession(), { type: 'bearer' })).status).toBe(404);
    expect(db.ensure).not.toHaveBeenCalled();
  });
});

describe('reserved handles and provenance shape', () => {
  it('reserves agent and the system names, case/at-insensitively', () => {
    for (const name of ['agent', '@Agent', 'OpenChat', 'assistant', 'system', 'support', 'feedback']) expect(isReservedUsername(name)).toBe(true);
    expect(isReservedUsername('agentsmith')).toBe(false);
    expect([...RESERVED_USERNAMES]).toContain('agent');
  });
  it('accepts exactly the Vision provenance contract', () => {
    expect(parseMessageProvenance(undefined)).toBeNull();
    expect(parseMessageProvenance({ service: 'vision', noteId: 'n1', ownerSubject: 's' })).toEqual({ service: 'vision', noteId: 'n1', ownerSubject: 's' });
    expect(parseMessageProvenance({ service: 'vision', noteId: 'n1', ownerSubject: 's', noteRevision: 1.5 })).toBe('invalid');
    expect(parseMessageProvenance({ service: 'vision', noteId: 'n 1', ownerSubject: 's' })).toBe('invalid');
  });
});

describe('durable reply delivery to Vision', () => {
  beforeEach(() => { vi.stubEnv('OPENCHAT_VISION_SECRET', 'o'.repeat(40)); vi.stubEnv('VISION_API_BASE', 'https://api.vision.test/'); });
  const provenanceJson = JSON.stringify({ service: 'vision', noteId: 'note-1', loopId: 'loop-1', ownerSubject: 'alice-sub' });

  it('enqueues a snapshot only for replies to Vision-provenance messages, idempotent by messageId', async () => {
    const tx = { run: vi.fn() };
    tx.run.mockResolvedValueOnce({ records: [record({ provenance: provenanceJson, ownerUserId: 'alice', repliedToMessageId: 'sent-1',
      conversationId: 'room', senderUserId: 'bob', senderName: 'Bob', content: 'Sounds good', createdAt: '2026-11-01T10:00:00Z' })] })
      .mockResolvedValueOnce({ records: [] });
    expect(await enqueueVisionReply(tx, 'reply-1')).toBe(true);
    const [mergeQuery, params] = tx.run.mock.calls[1];
    expect(mergeQuery).toMatch(/MERGE \(d:VisionReplyDelivery \{messageId:\$messageId\}\)\s+ON CREATE SET/);
    expect(JSON.parse(params.payload)).toEqual({ noteId: 'note-1', loopId: 'loop-1', ownerSubject: 'alice-sub', repliedToMessageId: 'sent-1',
      reply: { messageId: 'reply-1', conversationId: 'room', senderUserId: 'bob', senderName: 'Bob', content: 'Sounds good', createdAt: '2026-11-01T10:00:00Z' } });
    expect(new Date(params.expiresAt).getTime() - new Date(params.now).getTime()).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
    tx.run.mockReset().mockResolvedValue({ records: [] });
    expect(await enqueueVisionReply(tx, 'not-a-vision-reply')).toBe(false);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  const workerDb = (claim: Record<string, unknown> | null) => {
    const tx = { run: vi.fn(async (query: string) => query.includes("SET d.status='delivering'") ? { records: claim ? [record(claim)] : [] } : { records: [] }) };
    db.executeWrite.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    db.run.mockResolvedValue({ records: [] });
    return tx;
  };
  const driver = { session: () => db } as never;

  it('POSTs the payload with the bearer secret and marks it delivered', async () => {
    workerDb({ messageId: 'reply-1', payload: '{"noteId":"note-1"}', attempts: 1 });
    const transport = vi.fn().mockResolvedValue('delivered');
    expect(await runVisionReplyOnce(driver, transport)).toBe(true);
    expect(transport).toHaveBeenCalledWith('https://api.vision.test/openchat/replies', 'o'.repeat(40), '{"noteId":"note-1"}');
    expect(db.run.mock.calls[0][1]).toMatchObject({ messageId: 'reply-1', status: 'delivered' });
  });

  it('retries transient failures with backoff and stops on a permanent refusal', async () => {
    workerDb({ messageId: 'reply-1', payload: '{}', attempts: 2 });
    const now = Date.parse('2026-11-01T00:00:00Z');
    expect(await runVisionReplyOnce(driver, vi.fn().mockRejectedValue(new Error('down')), () => now)).toBe(true);
    expect(db.run.mock.calls[0][1]).toMatchObject({ status: 'pending', next: new Date(now + replyBackoff(2)).toISOString() });
    db.run.mockClear();
    workerDb({ messageId: 'reply-1', payload: '{}', attempts: 3 });
    await runVisionReplyOnce(driver, vi.fn().mockResolvedValue('rejected'));
    expect(db.run.mock.calls[0][1]).toMatchObject({ status: 'rejected' });
    expect(replyBackoff(1)).toBeLessThan(replyBackoff(3));
  });

  it('expires deliveries older than 24 hours with a log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tx = { run: vi.fn(async (query: string) => query.includes("d.status='expired'") ? { records: [record({ messageId: 'old', attempts: 9 })] } : { records: [] }) };
    db.executeWrite.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    expect(await runVisionReplyOnce(driver, vi.fn())).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gave up after 24h: message old'));
    warn.mockRestore();
  });

  it('does nothing until both the secret and Vision base are configured', async () => {
    vi.stubEnv('OPENCHAT_VISION_SECRET', '');
    expect(await runVisionReplyOnce(driver, vi.fn())).toBe(false);
    expect(db.executeWrite).not.toHaveBeenCalled();
  });
});

describe('Stream search over Vision', () => {
  const owner = { issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub' };
  const note = (id: string, extra: Record<string, unknown> = {}) => ({ id, bodyMd: `# ${id}\nbody`, createdAt: Date.parse('2026-10-01T00:00:00Z'), ...extra });
  beforeEach(() => resetVisionSearchState());

  it('passes the OpenChat source predicate and maps rows', async () => {
    const reader = vi.fn().mockResolvedValue({ result: { structuredContent: { notes: [note('n1', { url: 'https://vision.ideaflow.app/n/n1', sourcePlatform: 'openchat', hashtags: ['#idea'] })] } } });
    const result = await searchVision('alice', owner, 'idea', 'openchat', null, reader);
    expect(reader.mock.calls[0][1]).toBe('search_notes');
    expect(reader.mock.calls[0][2]).toMatchObject({ query: 'idea', source: { platform: 'openchat' }, limit: 25 });
    expect(result).toEqual({ status: 'ok', nextCursor: null, rows: [{ id: 'n1', text: '# n1\nbody', title: 'n1', createdAt: '2026-10-01T00:00:00.000Z',
      url: 'https://vision.ideaflow.app/n/n1', sourcePlatform: 'openchat', sourceLink: null, tags: ['idea'] }] });
  });

  it('falls back to client-side origin filtering when Vision lacks the source predicate', async () => {
    const reader = vi.fn()
      .mockResolvedValueOnce({ error: 'Source unavailable', code: 'source_unavailable' })
      .mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ notes: [
        note('saved', { bodyMd: 'x\n<!-- openchat-save:abc -->' }), note('import', { sourceLink: 'chat-import://openchat/1' }), note('other') ] }) }] });
    const result = await searchVision('alice', owner, 'x', 'openchat', null, reader);
    expect(reader.mock.calls[1][2]).not.toHaveProperty('source');
    expect(result.status === 'ok' && result.rows.map(r => r.id)).toEqual(['saved', 'import']);
    // Remembered: the next query skips the unsupported argument.
    await searchVision('alice', owner, 'y', 'openchat', null, reader);
    expect(reader.mock.calls[2][2]).not.toHaveProperty('source');
  });

  it('“All my notes” does not filter, pages 20 rows, and caches 30 s per user/query/chip', async () => {
    const reader = vi.fn().mockResolvedValue({ notes: Array.from({ length: 25 }, (_, i) => note('n' + i)) });
    const first = await searchVision('alice', owner, 'q', 'all', null, reader);
    expect(first.status === 'ok' && first.rows.length).toBe(20);
    const cursor = first.status === 'ok' ? decodeCursor(first.nextCursor!) : null;
    expect(cursor).toEqual({ o: 20 });
    const second = await searchVision('alice', owner, 'q', 'all', cursor as { o: number }, reader);
    expect(second.status === 'ok' && [second.rows.length, second.nextCursor]).toEqual([5, null]);
    await searchVision('alice', owner, 'Q', 'all', null, reader);
    expect(reader).toHaveBeenCalledTimes(2);
    await searchVision('bob', owner, 'q', 'all', null, reader);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('times out at the budget and reports unavailable codes without caching transient failures', async () => {
    const slow = vi.fn((_i, _t, _a, abort: AbortSignal) => new Promise((_, reject) => abort.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await searchVision('alice', owner, 'q', 'all', null, slow as never, 20)).toMatchObject({ status: 'unavailable', code: 'timeout' });
    const linked = vi.fn().mockResolvedValue({ error: 'x', code: 'account_link_required' });
    expect(await searchVision('alice', owner, 'q', 'all', null, linked)).toMatchObject({ status: 'unavailable', code: 'account_link_required' });
    expect(decodeCursor('not-base64-json')).toBe('invalid');
    expect(decodeCursor(encodeCursor({ o: 20 }))).toEqual({ o: 20 });
  });
});

describe('O7: Vision connect is single-flight and least-scope', () => {
  beforeEach(() => vi.stubEnv('OC_KEY_ENCRYPTION_SECRET', 'a'.repeat(64)));
  it('concurrent connects for one owner request exactly one key with vision:read vision:write', async () => {
    let lease: string | null = null;
    db.run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      if (query.includes('u.ideaflowIssuer AS issuer')) return { records: [record({ issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub' })] };
      if (query.includes('SET g.connectLease=$lease')) { if (lease) return { records: [record({ lease })] }; lease = params.lease as string; return { records: [record({ lease })] }; }
      if (query.includes('SET g.ciphertext')) return { records: params.lease === lease ? [record({ userId: 'alice' })] : [] };
      return { records: [] };
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ approval_url: 'https://id.ideaflow.app/agents/approve?x=1', confirmation_code: 'ABCD', expires_in: 600 }), { status: 200 }));
    const [a, b] = await Promise.all([connectVision('alice', fetchImpl as never), connectVision('alice', fetchImpl as never)]);
    expect(a).toEqual(b);
    expect(a).toEqual({ status: 'needs_auth', approvalUrl: 'https://id.ideaflow.app/agents/approve?x=1', confirmationCode: 'ABCD' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).scope).toBe('vision:read vision:write');
  });
  it('a second server that loses the lease shows the winner’s approval instead of requesting another key', async () => {
    let polls = 0;
    db.run.mockImplementation(async (query: string) => {
      if (query.includes('u.ideaflowIssuer AS issuer')) return { records: [record({ issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub' })] };
      if (query.includes('SET g.connectLease=$lease')) return { records: [record({ lease: 'other-server' })] };
      if (query.includes('g.expires > $now')) return { records: ++polls < 2 ? [] : [record({ approvalUrl: 'https://id.ideaflow.app/agents/approve?w=1', confirmationCode: 'WIN' })] };
      return { records: [] };
    });
    const fetchImpl = vi.fn();
    const result = await connectVision('alice', fetchImpl as never, { wait: async () => {} });
    expect(result).toEqual({ status: 'needs_auth', approvalUrl: 'https://id.ideaflow.app/agents/approve?w=1', confirmationCode: 'WIN' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
