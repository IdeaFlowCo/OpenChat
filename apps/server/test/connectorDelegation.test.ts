import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDelegatedConnector } from '../../mcp-server/src/delegated.js';
import { buildConnectorDelegationRoutes, connectorDelegationGuard } from '../src/routes/connectorDelegation.js';
import { ConnectorDelegationService } from '../src/services/connectorDelegation.js';
import type { Server } from 'node:http';

const verifier = 'A'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const callback = 'https://relying.example.test/oauth/openchat/callback';
const clientAuth = 'Basic ' + Buffer.from('fixture-client:fixture-secret').toString('base64');
const userJwt = (userId: string) => 'Bearer ' + jwt.sign({ userId, email: `${userId}@example.test` },
  process.env.JWT_SECRET || 'dev-secret-change-me');
const rp = (connectorGrantId: string, connectorUserId: string, openChatUserId: string) =>
  ({ connectorGrantId, connectorUserId, openChatUserId });

describe('disabled connector and bounded code delegation', () => {
  let now = 1_800_000_000_000;
  const service = new ConnectorDelegationService({ enabled: true, now: () => now,
    clients: [{ id: 'fixture-client', secret: 'fixture-secret', callbacks: [callback] }] });
  const app = express();
  app.use(express.json());
  app.use('/api', connectorDelegationGuard(service));
  app.use('/api/connector-delegations', buildConnectorDelegationRoutes(service));
  const memberships: Record<string, string[]> = { alice: ['shared', 'alice-only'], bob: ['shared', 'bob-only'] };
  const messages = new Map<string, { id: string; senderId: string; conversationId: string; content: string }>();
  app.get('/api/chat/conversations', (req, res) => res.json((memberships[req.user?.userId ?? ''] ?? []).map((id) => ({ id }))));
  app.get('/api/chat/conversations/:id/messages', (req, res) => {
    if (!memberships[req.user?.userId ?? '']?.includes(req.params.id)) { res.sendStatus(404); return; }
    res.json([...messages.values()].filter((m) => m.conversationId === req.params.id));
  });
  app.get('/api/chat/search', (req, res) => res.json({ messages: [], conversations: [],
    contacts: req.query.q === 'self' ? [{ id: req.user?.userId }] : [] }));
  app.post('/api/chat/conversations/:id/messages', (req, res) => {
    if (!memberships[req.user?.userId ?? '']?.includes(req.params.id)) { res.sendStatus(404); return; }
    const delegation = req.connectorDelegation!;
    const id = 'ocd_' + createHash('sha256').update(JSON.stringify([delegation.clientId,
      delegation.connectorGrantId, delegation.connectorUserId, delegation.openChatUserId,
      req.body.clientRequestId])).digest('hex');
    const existing = messages.get(id);
    if (existing) {
      if (existing.conversationId !== req.params.id || existing.content !== req.body.content) {
        res.sendStatus(409); return;
      }
      res.json(existing); return;
    }
    const message = { id, senderId: req.user!.userId,
      conversationId: req.params.id, content: req.body.content };
    messages.set(message.id, message);
    res.status(201).json(message);
  });
  app.get('/api/agent-keys', (_req, res) => res.sendStatus(200));
  let server: Server;
  let upstreamOrigin: string;
  const consentReviews: unknown[] = [];
  beforeAll(async () => {
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    upstreamOrigin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  async function issue(grant: string, connectorUser: string, openChatUser: string, scopes: string[] = ['openchat.read']) {
    const start = await request(app).post('/api/connector-delegations/start').set('Authorization', clientAuth).send({
      callback, connectorGrantId: grant, connectorUserId: connectorUser, scopes,
      state: `state-${grant}`, codeChallenge: challenge, expectedOpenChatUserId: openChatUser,
    });
    expect(start.status).toBe(200);
    const review = await request(app).get(start.body.reviewPath).set('Authorization', userJwt(openChatUser));
    expect(review.body).toMatchObject({ openChatUserId: openChatUser, scopes });
    consentReviews.push(review.body);
    const consent = await request(app).post('/api/connector-delegations/consent')
      .set('Authorization', userJwt(openChatUser)).send({ transaction: start.body.transaction, approvedScopes: scopes });
    expect(consent.status).toBe(303);
    const redirect = new URL(consent.headers.location);
    expect(redirect.origin + redirect.pathname).toBe(callback);
    const exchange = await request(app).post('/api/connector-delegations/token').set('Authorization', clientAuth).send({
      callback, code: redirect.searchParams.get('code'), state: redirect.searchParams.get('state'), codeVerifier: verifier,
    });
    expect(exchange.status).toBe(200);
    return { token: exchange.body.access_token as string, code: redirect.searchParams.get('code') as string };
  }

  it('remains absent by default and rejects unconfigured callbacks', async () => {
    const disabled = new ConnectorDelegationService({ enabled: false, clients: [] });
    const fixture = express(); fixture.use(express.json());
    fixture.use('/api/connector-delegations', buildConnectorDelegationRoutes(disabled));
    expect((await request(fixture).post('/api/connector-delegations/start')).status).toBe(404);
    const wrong = await request(app).post('/api/connector-delegations/start').set('Authorization', clientAuth).send({
      callback: 'https://production.example.test/callback', connectorGrantId: 'g', connectorUserId: 'u',
      scopes: ['openchat.read'], state: 'state', codeChallenge: challenge,
    });
    expect(wrong.status).toBe(400);
  });

  it('rejects account switch, wrong state, PKCE, callback, replay, and expiry', async () => {
    const start = await request(app).post('/api/connector-delegations/start').set('Authorization', clientAuth).send({
      callback, connectorGrantId: 'g-switch', connectorUserId: 'notes-alice', scopes: ['openchat.read'],
      state: 'opaque-state', codeChallenge: challenge, expectedOpenChatUserId: 'alice',
    });
    expect((await request(app).post('/api/connector-delegations/consent').set('Authorization', userJwt('bob'))
      .send({ transaction: start.body.transaction, approvedScopes: ['openchat.read'] })).status).toBe(403);
    const embeddedAlice = 'Bearer ' + jwt.sign({ userId: 'alice', email: 'shared-inbox@ideaflow.invalid', embedded: 'unlinked' },
      process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '10m' });
    expect((await request(app).get(start.body.reviewPath).set('Authorization', embeddedAlice)).status).toBe(403);
    expect((await request(app).post('/api/connector-delegations/consent').set('Authorization', embeddedAlice)
      .send({ transaction: start.body.transaction, approvedScopes: ['openchat.read'] })).status).toBe(403);
    expect((await request(app).post('/api/connector-delegations/consent').set('Authorization', userJwt('alice'))
      .send({ transaction: start.body.transaction, approvedScopes: ['openchat.read'] })).status).toBe(403);
    const { code } = await issue('g-code', 'notes-alice', 'alice');
    const replay = await request(app).post('/api/connector-delegations/token').set('Authorization', clientAuth)
      .send({ callback, code, state: 'state-g-code', codeVerifier: verifier });
    expect(replay.status).toBe(400);
    const testCode = (state: string, uri: string, pkce: string) => {
      const tx = service.start({ clientId: 'fixture-client', callback, connectorGrantId: 'g', connectorUserId: 'u',
        scopes: ['openchat.read'], state, codeChallenge: challenge });
      service.review(tx!, 'alice');
      const consent = service.consent(tx!, 'alice', ['openchat.read']);
      return service.exchange({ clientId: 'fixture-client', callback: uri, code: consent!.code, state, verifier: pkce });
    };
    expect(testCode('s', callback, 'B'.repeat(43))).toBeNull();
    expect(testCode('s', 'https://wrong.example.test/callback', verifier)).toBeNull();
    const tx = service.start({ clientId: 'fixture-client', callback, connectorGrantId: 'g', connectorUserId: 'u',
      scopes: ['openchat.read'], state: 's', codeChallenge: challenge })!;
    service.review(tx, 'alice');
    const code2 = service.consent(tx, 'alice', ['openchat.read'])!.code;
    expect(service.exchange({ clientId: 'fixture-client', callback, code: code2, state: 'wrong', verifier })).toBeNull();
    const tx2 = service.start({ clientId: 'fixture-client', callback, connectorGrantId: 'g', connectorUserId: 'u',
      scopes: ['openchat.read'], state: 's', codeChallenge: challenge })!;
    service.review(tx2, 'alice');
    now += 301_000;
    expect(service.consent(tx2, 'alice', ['openchat.read'])).toBeNull();
    const tx3 = service.start({ clientId: 'fixture-client', callback, connectorGrantId: 'g', connectorUserId: 'u',
      scopes: ['openchat.read'], state: 's', codeChallenge: challenge })!;
    expect(service.review(tx3, 'alice')).not.toBeNull();
    expect(service.review(tx3, 'bob')).toBeNull();
    expect(service.consent(tx3, 'bob', ['openchat.read'])).toBeNull();
  });

  it('keeps concurrent users isolated, enforces routes, sends exactly once, and revokes one grant', async () => {
    const alice = await issue('grant-a', 'notes-a', 'alice', ['openchat.read', 'openchat.send']);
    const bob = await issue('grant-b', 'notes-b', 'bob');
    const grants = new Map([
      ['grant-a', { ...rp('grant-a', 'notes-a', 'alice'), token: alice.token, scopes: ['openchat.read', 'openchat.send'] as Array<'openchat.read' | 'openchat.send'>, expiresAt: Date.now() + 30_000 }],
      ['grant-b', { ...rp('grant-b', 'notes-b', 'bob'), token: bob.token, scopes: ['openchat.read'] as Array<'openchat.read' | 'openchat.send'>, expiresAt: Date.now() + 30_000 }],
    ]);
    const connector = createDelegatedConnector({ upstreamOrigin, resolve: async (identity) => grants.get(identity.connectorGrantId) ?? null });
    expect(connector.toolNames).toEqual(['oc_list_conversations', 'oc_get_messages', 'oc_search_messages', 'oc_send_message']);
    const [a, b] = await Promise.all([
      connector.call(rp('grant-a', 'notes-a', 'alice'), 'oc_list_conversations', {}),
      connector.call(rp('grant-b', 'notes-b', 'bob'), 'oc_list_conversations', {}),
    ]);
    expect(a.content[0].text).toContain('alice-only');
    expect(a.content[0].text).not.toContain('bob-only');
    expect(b.content[0].text).toContain('bob-only');
    expect(b.content[0].text).not.toContain('alice-only');
    expect((await connector.call(rp('grant-b', 'notes-b', 'alice'), 'oc_list_conversations', {})).isError).toBe(true);
    expect((await connector.call(rp('grant-b', 'notes-b', 'bob'), 'oc_send_message',
      { conversationId: 'shared', text: 'forbidden', clientRequestId: 'one' })).isError).toBe(true);
    expect((await request(app).post('/api/chat/conversations/shared/messages').set('Authorization', `Bearer ${bob.token}`)
      .send({ content: 'forbidden' })).status).toBe(403);
    expect((await request(app).get('/api/agent-keys').set('Authorization', `Bearer ${alice.token}`)).status).toBe(403);
    expect((await request(app).get('/api/chat/conversations').set('Authorization', 'Bearer ocd_missing')).status).toBe(403);
    expect((await connector.call(rp('grant-a', 'notes-a', 'alice'), 'oc_get_messages', { conversationId: 'bob-only' })).isError).toBe(true);
    const search = await connector.call(rp('grant-b', 'notes-b', 'bob'), 'oc_search_messages', { query: 'self' });
    expect(search.content[0].text).toContain('bob');
    expect(search.content[0].text).not.toContain('alice');
    const args = { conversationId: 'shared', text: ' exact text ', clientRequestId: 'requested-action-1' };
    const first = await connector.call(rp('grant-a', 'notes-a', 'alice'), 'oc_send_message', args);
    const retry = await connector.call(rp('grant-a', 'notes-a', 'alice'), 'oc_send_message', args);
    expect(JSON.parse(first.content[0].text)).toMatchObject({ senderId: 'alice', content: args.text });
    expect(retry).toEqual(first);
    expect(messages.size).toBe(1);
    const read = await connector.call(rp('grant-a', 'notes-a', 'alice'), 'oc_get_messages', { conversationId: 'shared' });
    expect(JSON.parse(read.content[0].text)).toEqual([JSON.parse(first.content[0].text)]);
    expect(first.content[0].text).not.toContain(alice.token);
    expect((await request(app).post('/api/connector-delegations/revoke').set('Authorization', clientAuth).send({
      connectorGrantId: 'grant-a', connectorUserId: 'notes-a', openChatUserId: 'alice',
    })).status).toBe(204);
    expect((await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${alice.token}`)).status).toBe(403);
    expect((await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${bob.token}`)).status).toBe(200);
    if (process.env.OPENCHAT_TEST_EVIDENCE_DIR) writeFileSync(`${process.env.OPENCHAT_TEST_EVIDENCE_DIR}/connector-tools.json`, JSON.stringify({
      context: 'Local HTTP authorization-code/PKCE harness; synthetic chat endpoints and in-memory messages, no production traffic',
      tools: connector.toolNames, consentReviews,
      aliceConversations: JSON.parse(a.content[0].text), bobConversations: JSON.parse(b.content[0].text),
      searchAsBob: JSON.parse(search.content[0].text), sendAsAlice: JSON.parse(first.content[0].text),
      retry: JSON.parse(retry.content[0].text), readAsAlice: JSON.parse(read.content[0].text), persistedMessages: [...messages.values()],
      afterRevoke: { alice: (await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${alice.token}`)).status,
        bob: (await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${bob.token}`)).status },
      readOnlySend: await connector.call(rp('grant-b', 'notes-b', 'bob'), 'oc_send_message', args),
      nonmemberRead: await connector.call(rp('grant-b', 'notes-b', 'bob'), 'oc_get_messages', { conversationId: 'alice-only' }),
    }, null, 2));
    now += 3_600_001;
    expect((await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${bob.token}`)).status).toBe(403);
  });

  it('invalidates outstanding authorization state at revocation without affecting other identities', () => {
    const fixture = new ConnectorDelegationService({ enabled: true,
      clients: [{ id: 'fixture-client', secret: 'fixture-secret', callbacks: [callback] }] });
    const identity = { clientId: 'fixture-client', connectorGrantId: 'revoked', connectorUserId: 'notes-a' };
    const start = (overrides = {}) => fixture.start({ ...identity, callback, scopes: ['openchat.read'],
      state: 'revoke-state', codeChallenge: challenge, ...overrides })!;
    const pending = start();
    const expected = start({ expectedOpenChatUserId: 'alice' });
    const reviewed = start();
    fixture.review(reviewed, 'alice');
    const authorized = start();
    fixture.review(authorized, 'alice');
    const code = fixture.consent(authorized, 'alice', ['openchat.read'])!.code;
    const otherAccount = start();
    fixture.review(otherAccount, 'bob');
    const otherCode = fixture.consent(otherAccount, 'bob', ['openchat.read'])!.code;
    const otherGrant = start({ connectorGrantId: 'unrelated' });
    fixture.review(otherGrant, 'alice');
    fixture.revoke({ ...identity, openChatUserId: 'alice' });
    for (const tx of [pending, expected, reviewed]) {
      expect(fixture.review(tx, 'alice')).toBeNull();
      expect(fixture.consent(tx, 'alice', ['openchat.read'])).toBeNull();
    }
    expect(fixture.exchange({ clientId: identity.clientId, callback, code, state: 'revoke-state', verifier })).toBeNull();
    expect(fixture.exchange({ clientId: identity.clientId, callback, code: otherCode,
      state: 'revoke-state', verifier })?.delegation.openChatUserId).toBe('bob');
    expect(fixture.consent(otherGrant, 'alice', ['openchat.read'])).not.toBeNull();
  });

  it('returns a fixed tool error when delegation storage rejects', async () => {
    const connector = createDelegatedConnector({ upstreamOrigin,
      resolve: async () => { throw new Error('private storage details and ocd_secret'); } });
    await expect(connector.call(rp('grant', 'notes-a', 'alice'), 'oc_list_conversations', {}))
      .resolves.toEqual({ isError: true, content: [{ type: 'text', text: 'OpenChat request failed' }] });
  });

  it('denies notes-only grants and unrelated tools without contacting OpenChat', async () => {
    let resolutions = 0;
    const connector = createDelegatedConnector({ upstreamOrigin, resolve: async () => { resolutions++; return null; } });
    const identity = rp('notes-only', 'notes-user', 'alice');
    for (const name of connector.toolNames) {
      expect((await connector.call(identity, name, {})).isError).toBe(true);
    }
    expect(resolutions).toBe(4);
    expect((await connector.call(identity, 'oc_create_conversation', {})).isError).toBe(true);
    expect(resolutions).toBe(4);
  });

  it('allows separate read consent when send was requested', async () => {
    const tx = service.start({ clientId: 'fixture-client', callback, connectorGrantId: 'read-only',
      connectorUserId: 'notes-a', scopes: ['openchat.read', 'openchat.send'],
      state: 'state-read', codeChallenge: challenge })!;
    service.review(tx, 'alice');
    const consent = service.consent(tx, 'alice', ['openchat.read'])!;
    const result = service.exchange({ clientId: 'fixture-client', callback, code: consent.code,
      state: consent.state, verifier })!;
    expect(result.delegation.scopes).toEqual(['openchat.read']);
    expect(service.authorize(result.token, 'GET', '/api/chat/conversations')?.openChatUserId).toBe('alice');
    expect(service.authorize(result.token, 'POST', '/api/chat/conversations/shared/messages')).toBeNull();
    expect(service.authorize(result.token, 'GET', '/api/chat/conversations', 'bob')).toBeNull();
    expect(service.authorize(result.token, 'GET', '/api/agent-keys')).toBeNull();
  });
});
