import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
import router from '../src/routes/partnerGroups.js';
const app = express().use(express.json()).use('/api', router);
const secret = 'p'.repeat(40);
const issuer = 'https://id.ideaflow.app/api/auth';
const input = { issuer, subject: 'viewer-subject', conversationId: 'conv_group_1' };
const key = (sub: string) => createHash('sha256').update(`${issuer}\n${sub}`).digest('hex');
const record = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('IDEANETWORK_PARTNER_SECRET', secret);
  db.run.mockResolvedValue({ records: [record({ title: 'Design team', viewerRole: 'owner', members: [
    { name: 'Ava', role: 'owner', isBot: false, issuer, subject: 'viewer-subject' },
    { name: 'Sam', role: 'member', isBot: false, issuer, subject: 'sam-subject' },
    { name: 'Legacy', role: 'member', isBot: false, issuer: null, subject: null },
    { name: 'Helper', role: 'weird', isBot: true, issuer: 'https://evil.invalid', subject: 'x' },
  ] })] });
});
afterEach(() => vi.unstubAllEnvs());

it('returns names, roles and owner keys only to a participant of that group conversation', async () => {
  const reply = await request(app).post('/api/partners/ideanetwork/group-roster').auth(secret, { type: 'bearer' }).send(input);
  expect(reply.status).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.body).toEqual({ member: true, viewerRole: 'owner', title: 'Design team', conversationUrl: 'https://chat.ideaflow.app/app/chat/conv_group_1', members: [
    { name: 'Ava', role: 'owner', isBot: false, ownerKey: key('viewer-subject') },
    { name: 'Sam', role: 'member', isBot: false, ownerKey: key('sam-subject') },
    { name: 'Legacy', role: 'member', isBot: false, ownerKey: null },
    { name: 'Helper', role: 'member', isBot: true, ownerKey: null },
  ] });
  expect(JSON.stringify(reply.body)).not.toContain('sam-subject');
  const [cypher, params] = db.run.mock.calls[0];
  // The viewer must participate in this exact conversation, and it must be a group.
  expect(cypher).toContain('MATCH (viewer:User)-[vr:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})');
  expect(cypher).toContain("c.type = 'group'");
  expect(cypher).not.toMatch(/email|message|presence/i);
  expect(params).toEqual({ issuer, subject: 'viewer-subject', conversationId: 'conv_group_1' });
});

it('answers non-members and unknown conversations identically', async () => {
  db.run.mockResolvedValue({ records: [] });
  const reply = await request(app).post('/api/partners/ideanetwork/group-roster').auth(secret, { type: 'bearer' }).send(input);
  expect(reply.status).toBe(200); expect(reply.body).toEqual({ member: false });
});

it.each([
  [undefined, undefined, input, 401],
  ['wrong-secret-'.repeat(4), undefined, input, 401],
  [secret, 'https://social.ideaflow.app', input, 403],
  [secret, undefined, { ...input, issuer: 'https://evil.invalid' }, 400],
  [secret, undefined, { ...input, conversationId: '../x' }, 400],
  [secret, undefined, { ...input, subject: '' }, 400],
  [secret, undefined, { ...input, email: 'x@example.invalid' }, 400],
])('rejects unauthenticated, browser and malformed requests before reading the graph', async (auth, origin, body, status) => {
  let req = request(app).post('/api/partners/ideanetwork/group-roster');
  if (auth) req = req.auth(auth as string, { type: 'bearer' });
  if (origin) req = req.set('Origin', origin as string);
  expect((await req.send(body)).status).toBe(status); expect(db.run).not.toHaveBeenCalled();
});

it('fails closed without the partner secret configured', async () => {
  vi.stubEnv('IDEANETWORK_PARTNER_SECRET', '');
  expect((await request(app).post('/api/partners/ideanetwork/group-roster').auth(secret, { type: 'bearer' }).send(input)).status).toBe(503);
});
