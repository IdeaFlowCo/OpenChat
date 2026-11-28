import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1';
import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ driver: null as Driver | null, fetch: vi.fn(), generate: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => fixture.driver }));
vi.mock('../src/services/publicFetch.js', () => ({ publicGet: fixture.fetch }));
vi.mock('../src/services/profileAgent.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/profileAgent.js')>(),
  generateWithAnthropic: fixture.generate,
}));

import chatRoutes from '../src/routes/chat.js';
import agentKeyRoutes from '../src/routes/agentKeys.js';

const integration = process.env.NEO4J_TEST_URI ? describe.sequential : describe.skip;
integration('website recipient via authenticated OpenChat chat routes', () => {
  const prefix = `website-fixture-${randomUUID()}`;
  const viewer = `${prefix}-viewer`, rep = `${prefix}-representative`, delegate = `${prefix}-delegate`;
  const keys = [1, 2, 3].map(byte => Buffer.alloc(32, byte));
  const [siteKey, repKey, delegateKey] = keys.map(key => Buffer.from(schnorr.getPublicKey(key)).toString('hex'));
  let server: Server;
  let base: string;
  const secret = 'fixture-only-website-jwt';
  const cited = 'One checked bag is included in the fare.';
  let binding: ReturnType<typeof event>;
  let delegatedBinding: ReturnType<typeof event>;
  let delegation: ReturnType<typeof event>;
  let directDesignation: Record<string, unknown>;
  let delegatedDesignation: Record<string, unknown>;

  function event(index: number, tags: string[][]) {
    const pubkey = Buffer.from(schnorr.getPublicKey(keys[index])).toString('hex');
    const created_at = Math.floor(Date.now() / 1000);
    const content = '', kind = 30078;
    const hash = createHash('sha256').update(JSON.stringify([0, pubkey, created_at, kind, tags, content])).digest();
    return { pubkey, created_at, kind, content, tags, id: hash.toString('hex'), sig: Buffer.from(schnorr.sign(hash, keys[index])).toString('hex') };
  }

  async function req(path: string, body: unknown, userId = viewer, method = 'POST', agentKey?: string) {
    const auth = agentKey ?? jwt.sign({ userId, email: 'fixture@example.test' }, secret);
    const response = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { code: response.status, body: response.status === 204 ? null : await response.json() };
  }
  async function run(query: string, params = {}) {
    const session = fixture.driver!.session();
    try { return await session.run(query, params); } finally { await session.close(); }
  }
  async function messageCount() {
    const result = await run(`MATCH (u:User)-[:SENT]->(m:Message) WHERE u.id STARTS WITH $prefix RETURN count(m) AS n`, { prefix });
    return result.records[0].get('n').toNumber();
  }
  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', secret);
    vi.stubEnv('OC_KEY_ENCRYPTION_SECRET', '51'.repeat(32));
    fixture.driver = neo4j.driver(process.env.NEO4J_TEST_URI!,
      neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD || 'test'));
    await run(`UNWIND $users AS id CREATE (:User {id:id, name:id})`, { users: [viewer, rep, delegate] });
    const expiry = String(Math.floor(Date.now() / 1000) + 600);
    const makeBinding = (index: number, domain: string, host: string, user: string) =>
      event(index, [['d', `openchat-website-binding:v1:${domain}`], ['openchat-user', user], ['host', host], ['expiration', expiry]]);
    binding = makeBinding(1, 'airline.test', 'airline.test', rep);
    delegatedBinding = makeBinding(2, 'partner.test', 'host.test', delegate);
    delegation = event(0, [['d', 'openchat-website-delegation:v1:partner.test'], ['p', delegateKey], ['host', 'host.test'], ['expiration', expiry]]);
    directDesignation = { names: { _: siteKey, agent: repKey }, openchat_agent: { binding } };
    delegatedDesignation = { names: { _: siteKey, agent: delegateKey }, openchat_agent: { binding: delegatedBinding, delegation } };
    fixture.fetch.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/.well-known/nostr.json') {
        const data = parsed.hostname === 'airline.test' ? directDesignation : parsed.hostname === 'partner.test' ? delegatedDesignation : {};
        return { status: 200, body: Buffer.from(JSON.stringify(data)), headers: {}, url };
      }
      return parsed.hostname === 'unreadable.test'
        ? { status: 401, headers: {}, body: Buffer.alloc(0), url }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<p>${cited}</p><script>injected</script>`), url };
    });
    fixture.generate.mockResolvedValue({ text: JSON.stringify({ answer: 'One checked bag is included.', quote: cited }) });
    const app = express();
    app.use(express.json());
    app.use('/agent-keys', agentKeyRoutes);
    app.use(chatRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('No test server');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (!fixture.driver) return;
    await run(`MATCH (u:User)-[:PARTICIPATES_IN|SENT|OWNS_KEY]->(n) WHERE u.id STARTS WITH $prefix DETACH DELETE n`, { prefix });
    await run(`MATCH (u:User) WHERE u.id STARTS WITH $prefix DETACH DELETE u`, { prefix });
    await run(`MATCH (b:WebsiteBinding) WHERE b.id IN $ids DETACH DELETE b`, { ids: [binding?.id, delegatedBinding?.id].filter(Boolean) });
    await fixture.driver.close();
    vi.unstubAllEnvs();
  });

  const path = (part: string) => `/website-recipient/${part}`;
  const question = 'What about my bag?';
  it('keeps private reads separate from messaging and accepts selected text without a fetch', async () => {
    const answered = await req(path('ask'), { url: 'https://ordinary.test/baggage?secret=private#fragment', question });
    expect(answered).toEqual({ code: 200, body: { status: 'answered', answer: 'One checked bag is included.', quote: cited, url: 'https://ordinary.test/baggage' } });
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual(['https://ordinary.test/baggage']);
    expect(fixture.generate.mock.calls[0][0].user).not.toContain('injected');
    expect(await messageCount()).toBe(0);
    expect((await req(path('ask'), { url: 'https://unreadable.test/policy', question })).body).toEqual({ status: 'unreadable' });
    fixture.fetch.mockClear();
    expect((await req(path('ask'), { url: 'https://ordinary.test/booking/X03', question })).body).toEqual({ status: 'unreadable' });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect((await req(path('ask'), { question, excerpt: cited })).body).toMatchObject({ status: 'answered', quote: cited });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(await messageCount()).toBe(0);
  });

  it('requires account consent and review, routes two pages to one contact, and receives a real attributed reply', async () => {
    const draft = { url: 'https://airline.test/baggage?signature=private', question };
    expect((await req(path('review'), draft)).body).toEqual({ status: 'unverified' });
    expect((await req(path('binding'), { event: binding }, viewer, 'PUT')).code).toBe(400);
    expect((await req(path('binding'), { event: binding }, rep, 'PUT')).code).toBe(200);
    const first = (await req(path('review'), draft)).body;
    expect(first).toMatchObject({ status: 'verified', domain: 'airline.test', content: `${question}\n\nWebsite context: airline.test/baggage` });
    expect(await messageCount()).toBe(0);
    expect((await req(path('send'), { token: first.token })).code).toBe(409);
    expect((await req(path('send'), { token: first.token, confirmed: true }, delegate)).code).toBe(409);
    const sent = await req(path('send'), { token: first.token, confirmed: true });
    expect(sent).toMatchObject({ code: 201, body: { content: first.content, senderId: viewer } });
    expect((await req(path('send'), { token: first.token, confirmed: true })).body.id).toBe(sent.body.id);
    const second = (await req(path('review'), { ...draft, url: 'https://airline.test/refunds' })).body;
    const next = await req(path('send'), { token: second.token, confirmed: true });
    expect(next.body).toMatchObject({ conversationId: sent.body.conversationId, content: `${question}\n\nWebsite context: airline.test/refunds` });
    const key = await req('/agent-keys', { name: 'Fixture representative agent', scopes: ['read', 'write'] }, rep);
    expect(key.code).toBe(201);
    const reply = await req(`/conversations/${sent.body.conversationId}/messages`, { content: 'Official fixture answer', replyToId: sent.body.id }, rep, 'POST', key.body.key);
    expect(reply).toMatchObject({ code: 201, body: { senderId: rep, conversationId: sent.body.conversationId, replyToId: sent.body.id } });
    expect(await messageCount()).toBe(3);
  });

  it('accepts signed external hosting and rejects tampering, revocation and missing representatives', async () => {
    const draft = { url: 'https://partner.test/policy', question };
    expect((await req(path('binding'), { event: delegatedBinding }, delegate, 'PUT')).code).toBe(200);
    const valid = (await req(path('review'), draft)).body;
    expect(valid).toMatchObject({ status: 'verified', host: 'host.test', domain: 'partner.test' });
    const before = await messageCount();
    delegatedDesignation = { ...delegatedDesignation, openchat_agent: { binding: delegatedBinding, delegation: { ...delegation, sig: '00'.repeat(64) } } };
    expect((await req(path('review'), draft)).body).toEqual({ status: 'unverified' });
    expect((await req(path('send'), { token: valid.token, confirmed: true })).code).toBe(409);
    delegatedDesignation.openchat_agent = { binding: delegatedBinding, delegation };
    const sent = await req(path('send'), { token: valid.token, confirmed: true });
    expect(sent).toMatchObject({ code: 201, body: { senderId: viewer, content: valid.content } });
    const members = await run(`MATCH (u:User)-[:PARTICIPATES_IN]->(:Conversation {id:$id}) RETURN collect(u.id) AS ids`, { id: sent.body.conversationId });
    expect(members.records[0].get('ids').sort()).toEqual([viewer, delegate].sort());
    await req(path('binding/partner.test'), undefined, delegate, 'DELETE');
    expect((await req(path('send'), { token: valid.token, confirmed: true })).code).toBe(409);
    expect((await req(path('review'), { ...draft, url: 'https://ordinary.test' })).body).toEqual({ status: 'unverified' });
    expect(await messageCount()).toBe(before + 1);
  });
});
