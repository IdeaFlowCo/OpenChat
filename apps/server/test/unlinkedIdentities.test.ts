import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
import router from '../src/routes/unlinkedMessaging.js';
const app = express().use(express.json()).use('/api', router);
const secret = 's'.repeat(40);
const issuer = 'https://id.ideaflow.app/api/auth';
const input = { issuer, subject: 'viewer-subject', userIds: ['oc-ava', 'oc-sam', 'oc-ava'] };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('UNLINKED_MESSAGING_SECRET', secret);
  db.run.mockResolvedValue({ records: [{ get: (key: string) => ({ userId: 'oc-ava', subject: 'ava-subject' })[key] }] });
});
afterEach(() => vi.unstubAllEnvs());

it('answers the trusted server with identities of the member\'s own conversation partners only', async () => {
  const reply = await request(app).post('/api/unlinked/identities').auth(secret, { type: 'bearer' }).send(input);
  expect(reply.status).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.body).toEqual({ identities: [{ userId: 'oc-ava', issuer, subject: 'ava-subject' }] });
  const [cypher, params] = db.run.mock.calls[0];
  // Scoped to the viewer's shared inbox and its visible conversations; blocked pairs excluded.
  expect(cypher).toContain('MATCH (viewer:User {ideaflowIdentityKey: $key})');
  expect(cypher).toContain('MATCH (viewer)-[:PARTICIPATES_IN]->(c:Conversation)<-[:PARTICIPATES_IN]-(other:User {id: otherId})');
  expect(cypher).toContain('NOT (viewer)-[:BLOCKED]-(other)');
  expect(cypher).not.toMatch(/email|name/i);
  expect(params).toEqual({ key: `${issuer}\u001fviewer-subject`, issuer, subject: 'viewer-subject', userIds: ['oc-ava', 'oc-sam'] });
});

it.each([
  [undefined, undefined, input, 401],
  ['wrong-secret-'.repeat(4), undefined, input, 401],
  [secret, 'https://www.unlinked.ai', input, 403],
  [secret, undefined, { ...input, issuer: 'https://evil.invalid' }, 400],
  [secret, undefined, { ...input, userIds: [] }, 400],
  [secret, undefined, { ...input, userIds: ['../x'] }, 400],
  [secret, undefined, { ...input, userIds: Array.from({ length: 201 }, (_, i) => `u${i}`) }, 400],
  [secret, undefined, { ...input, email: 'x@example.invalid' }, 400],
])('rejects unauthenticated, browser and malformed requests before reading the graph', async (key, origin, body, status) => {
  let req = request(app).post('/api/unlinked/identities');
  if (key) req = req.auth(key as string, { type: 'bearer' });
  if (origin) req = req.set('Origin', origin as string);
  expect((await req.send(body)).status).toBe(status); expect(db.run).not.toHaveBeenCalled();
});

it('fails closed without the service secret configured', async () => {
  vi.stubEnv('UNLINKED_MESSAGING_SECRET', '');
  expect((await request(app).post('/api/unlinked/identities').auth(secret, { type: 'bearer' }).send(input)).status).toBe(503);
});
