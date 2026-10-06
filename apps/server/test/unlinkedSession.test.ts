import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
import router from '../src/routes/unlinkedMessaging.js';
const app = express().use(express.json()).use('/api', router);
const secret = 's'.repeat(40);
const input = { issuer: 'https://id.ideaflow.app/api/auth', subject: 'verified', name: 'Avery' };
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('UNLINKED_MESSAGING_SECRET', secret); vi.stubEnv('JWT_SECRET', 'test-jwt-key'); db.run.mockResolvedValue({ records: [{ get: (key: string) => ({ id: 'same-inbox', name: 'Avery' })[key] }] }); });
afterEach(() => vi.unstubAllEnvs());
it('only the trusted server can mint a short-lived session for the shared inbox', async () => {
  const reply = await request(app).post('/api/unlinked/session').auth(secret, { type: 'bearer' }).send(input);
  expect(reply.status).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.body.user.userId).toBe('same-inbox');
  const claims = jwt.verify(reply.body.token, 'test-jwt-key') as jwt.JwtPayload;
  expect(claims.userId).toBe('same-inbox'); expect(claims.exp! - claims.iat!).toBe(600); expect(claims.embedded).toBe('unlinked');
  expect(db.run.mock.calls[0][1].key).toBe(input.issuer + '\u001fverified');
});
it.each([
  [undefined, undefined, input, 401], [secret, 'https://www.unlinked.ai', input, 403],
  [secret, undefined, { ...input, userId: 'victim' }, 400],
  [secret, undefined, { ...input, issuer: 'https://evil.invalid' }, 400],
  [secret, undefined, { ...input, subject: '' }, 400],
])('rejects unauthenticated/browser/forged identity requests', async (key, origin, body, status) => {
  let req = request(app).post('/api/unlinked/session');
  if (key) req = req.auth(key as string, { type: 'bearer' });
  if (origin) req = req.set('Origin', origin as string);
  expect((await req.send(body)).status).toBe(status); expect(db.run).not.toHaveBeenCalled();
});
