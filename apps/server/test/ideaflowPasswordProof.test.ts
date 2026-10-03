import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// code-xbh.7: an account with a password but a never-verified email is linked
// to an Ideaflow identity only after a password proof (aligned with Noos PR #58).

const db = vi.hoisted(() => ({
  results: [] as Array<Array<Record<string, unknown>>>,
  run: vi.fn(),
}));
const oidc = vi.hoisted(() => ({ exchange: vi.fn() }));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: db.run, close: vi.fn() }),
  }),
}));
vi.mock('../src/services/assistant.js', () => ({ ensureAssistantConversation: vi.fn() }));
vi.mock('../src/services/ideaflowOidc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ideaflowOidc.js')>();
  return { ...actual, exchangeIdeaflowAuthorizationCode: oidc.exchange };
});

import authRouter, { signIdeaflowLinkTicket } from '../src/routes/auth.js';
import { validateToken } from '../src/middleware/auth.js';

const SECRET = 'test-secret';
const identity = {
  issuer: 'https://id.ideaflow.app/api/auth',
  subject: 'subject-1',
  email: 'person@example.test',
  emailVerified: true,
  name: 'Person',
  picture: null,
};
const sessionFor = (userId: string, email = identity.email) => jwt.sign({ userId, email }, SECRET, { expiresIn: '1h' });

describe('Ideaflow password-proof linking', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    process.env.IDEAFLOW_ID_ENABLED = 'true';
    process.env.IDEAFLOW_ID_ISSUER = identity.issuer;
    process.env.IDEAFLOW_ID_CLIENT_ID = 'openchat-web';
    process.env.IDEAFLOW_ID_CLIENT_SECRET = 'server-secret';
    process.env.IDEAFLOW_ID_REDIRECT_URI = 'https://chat.ideaflow.app/auth/ideaflow/callback';
    db.results = [];
    db.run.mockReset();
    db.run.mockImplementation(async () => ({
      records: (db.results.shift() ?? []).map(user => ({ get: () => user })),
    }));
    oidc.exchange.mockReset();
  });

  afterEach(() => {
    for (const key of ['JWT_SECRET', 'IDEAFLOW_ID_ENABLED', 'IDEAFLOW_ID_ISSUER', 'IDEAFLOW_ID_CLIENT_ID',
      'IDEAFLOW_ID_CLIENT_SECRET', 'IDEAFLOW_ID_REDIRECT_URI']) delete process.env[key];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
  });

  const link = (body: unknown, bearer?: string) => fetch(`${baseUrl}/api/auth/ideaflow/link-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });

  it('exchange answers 409 password_proof_required with a ticket instead of linking', async () => {
    oidc.exchange.mockResolvedValue(identity);
    db.results = [[], [{ id: 'legacy', email: 'Person@example.test', name: 'L', hasPassword: true }]];
    const response = await fetch(`${baseUrl}/api/auth/ideaflow/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'authorization-code', codeVerifier: 'v'.repeat(43), nonce: 'n'.repeat(16) }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('password_proof_required');
    expect(body.email).toBe(identity.email);
    expect(body.token).toBeUndefined();
    expect(typeof body.linkTicket).toBe('string');
    expect(db.run).toHaveBeenCalledTimes(2);
  });

  it('never accepts a link ticket as a session token', () => {
    expect(validateToken(signIdeaflowLinkTicket(identity))).toBeNull();
  });

  it('requires a signed-in bearer (the password proof)', async () => {
    const response = await link({ linkTicket: signIdeaflowLinkTicket(identity) });
    expect(response.status).toBe(401);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('rejects a missing, forged or wrong-audience ticket', async () => {
    for (const linkTicket of [undefined, 'not-a-jwt', sessionFor('legacy'),
      jwt.sign({ purpose: 'ideaflow-link', ideaflowIssuer: 'x', ideaflowSubject: 'y', ideaflowEmail: identity.email }, 'other-secret', { audience: 'openchat-ideaflow-link' })]) {
      const response = await link({ linkTicket }, sessionFor('legacy'));
      expect(response.status).toBe(400);
    }
    expect(db.run).not.toHaveBeenCalled();
  });

  it('refuses when the proven account is not the one that owns the Ideaflow email', async () => {
    db.results = [[{ id: 'legacy', email: identity.email, name: 'L' }]];
    const response = await link({ linkTicket: signIdeaflowLinkTicket(identity) }, sessionFor('someone-else', 'other@example.test'));
    expect(response.status).toBe(403);
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('refuses when the email is ambiguous', async () => {
    db.results = [[{ id: 'legacy', email: identity.email }, { id: 'legacy-2', email: identity.email }]];
    const response = await link({ linkTicket: signIdeaflowLinkTicket(identity) }, sessionFor('legacy'));
    expect(response.status).toBe(403);
  });

  it('binds the identity after the password proof and returns an OpenChat session', async () => {
    const user = { id: 'legacy', email: identity.email, name: 'Legacy' };
    db.results = [[user], [user]];
    const response = await link({ linkTicket: signIdeaflowLinkTicket(identity) }, sessionFor('legacy'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toEqual(user);
    expect(validateToken(body.token)).toMatchObject({ userId: 'legacy' });
    const [bindQuery, bindParams] = db.run.mock.calls[1];
    expect(String(bindQuery)).toContain('u.ideaflowSub = $subject');
    expect(bindParams).toMatchObject({ userId: 'legacy', subject: identity.subject, issuer: identity.issuer });
  });

  it('refuses to overwrite a different Ideaflow identity on the proven account', async () => {
    db.results = [[{ id: 'legacy', email: identity.email }], []];
    const response = await link({ linkTicket: signIdeaflowLinkTicket(identity) }, sessionFor('legacy'));
    expect(response.status).toBe(409);
  });
});
