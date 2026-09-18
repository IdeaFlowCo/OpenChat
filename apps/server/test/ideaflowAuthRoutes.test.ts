import express from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const oidcMocks = vi.hoisted(() => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
}));

vi.mock('../src/services/ideaflowOidc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ideaflowOidc.js')>();
  return {
    ...actual,
    buildIdeaflowAuthorizationUrl: oidcMocks.buildAuthorizationUrl,
    exchangeIdeaflowAuthorizationCode: oidcMocks.exchangeAuthorizationCode,
  };
});

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: vi.fn(),
      close: vi.fn(),
    }),
  }),
}));

import authRouter from '../src/routes/auth.js';
import { resetIdeaflowLinkFlows } from '../src/services/ideaflowLinkFlow.js';

function signTestToken(email: string, userId = 'test-user-1', sessionId = 'session-a'): string {
  // JWT_SECRET is unset in this test file, so auth.ts and middleware/auth.ts
  // both fall back to the same 'dev-secret-change-me' default.
  return jwt.sign({ userId, email, sessionId }, 'dev-secret-change-me', { expiresIn: '1h' });
}

const LINK_STATE = 'link.' + 's'.repeat(32);
const LINK_NONCE = 'n'.repeat(32);
const LINK_VERIFIER = 'v'.repeat(64);
const LINK_CHALLENGE = createHash('sha256').update(LINK_VERIFIER).digest('base64url');

describe('Ideaflow ID auth routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    resetIdeaflowLinkFlows();
    process.env.IDEAFLOW_ID_ENABLED = 'true';
    process.env.IDEAFLOW_ID_ISSUER = 'https://id.ideaflow.app/api/auth';
    process.env.IDEAFLOW_ID_CLIENT_ID = 'openchat-web';
    process.env.IDEAFLOW_ID_CLIENT_SECRET = 'server-secret';
    process.env.IDEAFLOW_ID_REDIRECT_URI = 'https://chat.globalbr.ai/auth/ideaflow/callback';
    oidcMocks.buildAuthorizationUrl.mockReset();
    oidcMocks.buildAuthorizationUrl.mockResolvedValue(
      'https://id.ideaflow.app/api/auth/oauth2/authorize?request=test',
    );
    oidcMocks.exchangeAuthorizationCode.mockReset();
    oidcMocks.exchangeAuthorizationCode.mockResolvedValue({
      issuer: 'https://id.ideaflow.app/api/auth',
      subject: 'verified-subject',
      email: 'verified-idp@example.test',
      emailVerified: true,
      name: 'Verified Person',
      picture: null,
    });
  });

  async function startLink(token: string, state = LINK_STATE) {
    return fetch(
      `${baseUrl}/api/auth/ideaflow/link/url?state=${state}&nonce=${LINK_NONCE}&code_challenge=${LINK_CHALLENGE}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  async function exchangeLink(token: string, state = LINK_STATE) {
    return fetch(`${baseUrl}/api/auth/ideaflow/link/exchange`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'valid-looking-code',
        codeVerifier: LINK_VERIFIER,
        nonce: LINK_NONCE,
        state,
      }),
    });
  }

  afterEach(() => {
    delete process.env.IDEAFLOW_ID_ENABLED;
    delete process.env.IDEAFLOW_ID_ISSUER;
    delete process.env.IDEAFLOW_ID_CLIENT_ID;
    delete process.env.IDEAFLOW_ID_CLIENT_SECRET;
    delete process.env.IDEAFLOW_ID_REDIRECT_URI;
    delete process.env.IDEAFLOW_ID_COHORT_ALLOWLIST;
    delete process.env.IDEAFLOW_ID_ALLOW_NEW_USER_CREATION;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('reports only the public enabled capability and disables caching', async () => {
    const response = await fetch(`${baseUrl}/api/auth/ideaflow/config`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('stays unavailable when the explicit rollout flag is off', async () => {
    process.env.IDEAFLOW_ID_ENABLED = 'false';

    const config = await fetch(`${baseUrl}/api/auth/ideaflow/config`);
    const start = await fetch(`${baseUrl}/api/auth/ideaflow/url`);
    const exchange = await fetch(`${baseUrl}/api/auth/ideaflow/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(await config.json()).toEqual({ enabled: false });
    expect(start.status).toBe(503);
    expect(exchange.status).toBe(503);
  });

  it('rejects malformed state and PKCE inputs before contacting the provider', async () => {
    const response = await fetch(
      `${baseUrl}/api/auth/ideaflow/url?state=short&nonce=short&code_challenge=short`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Valid state and nonce are required' });
  });

  it('rejects malformed exchange inputs before contacting the provider', async () => {
    const response = await fetch(`${baseUrl}/api/auth/ideaflow/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'valid-looking-code',
        codeVerifier: 'too-short',
        nonce: 'nonce-value-1234567890',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A valid PKCE code verifier is required' });
  });

  describe('explicit signed-in linking', () => {
    it('requires an authenticated session for /ideaflow/link/url', async () => {
      const response = await fetch(`${baseUrl}/api/auth/ideaflow/link/url?state=${'s'.repeat(20)}&nonce=${'n'.repeat(20)}&code_challenge=${'a'.repeat(43)}`);
      expect(response.status).toBe(401);
    });

    it('requires an authenticated session for /ideaflow/link/exchange', async () => {
      const response = await fetch(`${baseUrl}/api/auth/ideaflow/link/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    });

    it('requires an authenticated session for /ideaflow/link/status', async () => {
      const response = await fetch(`${baseUrl}/api/auth/ideaflow/link/status`);
      expect(response.status).toBe(401);
    });

    it('stays disabled by the global kill switch even for an authenticated caller', async () => {
      process.env.IDEAFLOW_ID_ENABLED = 'false';
      const token = signTestToken('member@example.test');

      const url = await startLink(token);
      const exchange = await fetch(`${baseUrl}/api/auth/ideaflow/link/exchange`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(url.status).toBe(503);
      expect(exchange.status).toBe(503);
    });

    it('starts linking for an authenticated legacy session, then fails closed on the verified IdP email', async () => {
      const token = signTestToken('member@example.test');

      const url = await startLink(token);
      const exchange = await exchangeLink(token);

      expect(url.status).toBe(200);
      expect(exchange.status).toBe(403);
      expect(oidcMocks.buildAuthorizationUrl).toHaveBeenCalledTimes(1);
      expect(oidcMocks.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    });

    it('uses the verified IdP email for the cohort even when the legacy session email differs', async () => {
      process.env.IDEAFLOW_ID_COHORT_ALLOWLIST = 'verified-idp@example.test';
      const token = signTestToken('member@example.test');

      expect((await startLink(token)).status).toBe(200);
      const response = await exchangeLink(token);

      // The mocked DB has no current user, so binding fails after the gate.
      // A non-403 proves the verified IdP email, not the legacy JWT email,
      // selected the cohort.
      expect(response.status).toBe(500);
      expect(oidcMocks.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
      delete process.env.IDEAFLOW_ID_COHORT_ALLOWLIST;
    });

    it('binds the callback to the exact initiating user and session', async () => {
      const tokenA = signTestToken('a@example.test', 'user-a', 'session-a');
      const tokenB = signTestToken('b@example.test', 'user-b', 'session-b');
      expect((await startLink(tokenA)).status).toBe(200);

      const switched = await exchangeLink(tokenB);

      expect(switched.status).toBe(401);
      expect(oidcMocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it('consumes each link flow once before provider exchange', async () => {
      const token = signTestToken('member@example.test');
      expect((await startLink(token)).status).toBe(200);

      const first = await exchangeLink(token);
      const replay = await exchangeLink(token);

      expect(first.status).not.toBe(401);
      expect(replay.status).toBe(401);
      expect(oidcMocks.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    });

    it('never overwrites an existing link transaction for the same state', async () => {
      const tokenA = signTestToken('a@example.test', 'user-a', 'session-a');
      const tokenB = signTestToken('b@example.test', 'user-b', 'session-b');

      expect((await startLink(tokenA)).status).toBe(200);
      expect((await startLink(tokenB)).status).toBe(409);
      expect((await exchangeLink(tokenA)).status).not.toBe(401);
      expect(oidcMocks.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed link/exchange inputs the same way as the sign-in endpoint', async () => {
      process.env.IDEAFLOW_ID_COHORT_ALLOWLIST = '*';
      const token = signTestToken('member@example.test');

      const response = await fetch(`${baseUrl}/api/auth/ideaflow/link/exchange`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'valid-looking-code', codeVerifier: 'too-short', nonce: 'n'.repeat(20) }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'A valid PKCE code verifier is required' });
      delete process.env.IDEAFLOW_ID_COHORT_ALLOWLIST;
    });
  });
});
