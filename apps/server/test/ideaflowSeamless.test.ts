import express from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  verifyPassword: vi.fn(),
  users: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/services/ideaflowOidc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ideaflowOidc.js')>();
  return {
    ...actual,
    buildIdeaflowAuthorizationUrl: mocks.buildAuthorizationUrl,
    exchangeIdeaflowAuthorizationCode: mocks.exchangeAuthorizationCode,
  };
});
vi.mock('../src/services/noosPasswordCheck.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/noosPasswordCheck.js')>()),
  verifyPasswordViaNoos: mocks.verifyPassword,
}));

// A tiny stateful stand-in for the shared Neo4j :User nodes. It models only the
// statements the resolver/confirm/bind code issues, keyed by distinctive text.
function fakeRun(query: string, params: Record<string, unknown>) {
  const q = String(query);
  const rows = (found: Array<Record<string, unknown>>) => ({ records: found.map(u => ({ get: () => u })) });
  const users = mocks.users;
  const hasPassword = (u: Record<string, unknown>) => u.passwordHash != null && u.passwordHash !== '';
  if (q.includes('mapped: true') && q.includes('MATCH (u:User {id: $userId})')) {
    return rows(users
      .filter(u => u.id === params.userId && u.ideaflowIdentityKey === params.identityKey)
      .map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, hasPassword: hasPassword(u), mapped: true })));
  }
  if (q.includes('u.ideaflowIdentityKey = $identityKey') && q.includes('LIMIT 3') && !q.includes('u.id <>')) {
    return rows(users
      .filter(u => u.ideaflowIdentityKey === params.identityKey)
      .map(u => ({ ...u, linkedVia: u.ideaflowLinkedVia, hasPassword: hasPassword(u) })));
  }
  if (q.includes("toLower(coalesce(u.email, '')) = $emailLookup")) {
    return rows(users
      .filter(u => String(u.email ?? '').toLowerCase() === params.emailLookup)
      .map(u => ({
        id: u.id, email: u.email, name: u.name, role: u.role,
        signupProvider: u.signupProvider, googleEmailVerified: u.googleEmailVerified,
        hasPassword: hasPassword(u),
        hasGoogleSub: u.googleSub != null,
        mapped: u.ideaflowIdentityKey != null || u.ideaflowSub != null,
      })));
  }
  if (q.includes('_ideaflowBindingLock')) {
    return rows(users.filter(u => u.id === params.userId).map(u => ({ ...u, linkedVia: u.ideaflowLinkedVia, hasPassword: hasPassword(u) })));
  }
  if (q.includes('SET u.ideaflowLinkedVia = $provenance')) {
    const user = users.find(u => u.id === params.userId && u.ideaflowIdentityKey === params.identityKey);
    if (user) user.ideaflowLinkedVia = params.provenance;
    return rows([]);
  }
  if (q.includes('u.id <> $userId')) {
    return rows(users.filter(u => u.id !== params.userId && u.ideaflowIdentityKey === params.identityKey));
  }
  if (q.includes('SET u.ideaflowIssuer')) {
    const user = users.find(u => u.id === params.userId)!;
    Object.assign(user, {
      ideaflowIssuer: params.issuer,
      ideaflowSub: params.subject,
      ideaflowIdentityKey: params.identityKey,
      ideaflowLinkedVia: params.provenance ?? undefined,
    });
    return rows([{ id: user.id, email: user.email, name: user.name }]);
  }
  if (q.includes('SET u.lastSeenAt')) {
    return rows(users.filter(u => u.id === params.userId).map(u => ({ id: u.id, email: u.email, name: u.name })));
  }
  return rows([]);
}

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: async (q: string, p: Record<string, unknown>) => fakeRun(q, p),
      executeWrite: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ run: async (q: string, p: Record<string, unknown>) => fakeRun(q, p) }),
      close: vi.fn(),
    }),
  }),
}));

import authRouter from '../src/routes/auth.js';
import { resetIdeaflowConfirmFlows } from '../src/services/ideaflowConfirmFlow.js';
import { resetIdeaflowLinkFlows } from '../src/services/ideaflowLinkFlow.js';

const ISSUER = 'https://id.ideaflow.app/api/auth';
const KEY = (sub: string) => `${ISSUER}${String.fromCharCode(31)}${sub}`;
const STATE = 'state.' + 's'.repeat(30);
const NONCE = 'n'.repeat(32);
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function identity(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    subject: 'sub-new',
    email: 'person@example.test',
    emailVerified: true,
    name: 'Person',
    picture: null,
    authTime: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('Ideaflow seamless account resolution (OpenChat)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    resetIdeaflowConfirmFlows();
    resetIdeaflowLinkFlows();
    mocks.users.length = 0;
    process.env.IDEAFLOW_ID_ENABLED = 'true';
    process.env.IDEAFLOW_ID_ISSUER = ISSUER;
    process.env.IDEAFLOW_ID_CLIENT_ID = 'openchat-web';
    process.env.IDEAFLOW_ID_CLIENT_SECRET = 'server-secret';
    process.env.IDEAFLOW_ID_REDIRECT_URI = 'https://chat.globalbr.ai/auth/ideaflow/callback';
    process.env.IDEAFLOW_ID_COHORT_ALLOWLIST = '*';
    mocks.buildAuthorizationUrl.mockReset();
    mocks.buildAuthorizationUrl.mockResolvedValue('https://id.ideaflow.app/api/auth/oauth2/authorize?x=1');
    mocks.exchangeAuthorizationCode.mockReset();
    mocks.exchangeAuthorizationCode.mockResolvedValue(identity());
    mocks.verifyPassword.mockReset();
  });

  afterEach(() => {
    for (const name of Object.keys(process.env).filter(n => n.startsWith('IDEAFLOW_ID_'))) delete process.env[name];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });

  const exchange = () => fetch(`${baseUrl}/api/auth/ideaflow/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'valid-looking-code', codeVerifier: VERIFIER, nonce: NONCE }),
  });
  const confirm = (confirmId: string, password = 'hunter2') => fetch(`${baseUrl}/api/auth/ideaflow/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmId, password }),
  });
  const passwordUser = (over: Record<string, unknown> = {}) => ({
    id: 'u-pass', email: 'Person@Example.test', name: 'Pass', passwordHash: 'x', ...over,
  });

  describe('returning and new people', () => {
    it('signs a returning subject in by exact mapping and never consults email', async () => {
      mocks.users.push({
        id: 'u1', email: 'other@example.test', name: 'One',
        ideaflowIssuer: ISSUER, ideaflowSub: 'sub-new', ideaflowIdentityKey: KEY('sub-new'),
      });
      const res = await exchange();
      expect(res.status).toBe(200);
      expect((await res.json()).user.id).toBe('u1');
    });

    it('does not create a second account while new-user creation is off', async () => {
      mocks.exchangeAuthorizationCode.mockResolvedValue(identity({ email: 'nobody@example.test' }));
      const res = await exchange();
      expect(res.status).toBe(403);
      expect(mocks.users).toHaveLength(0);
    });
  });

  describe('safe automatic linking', () => {
    it('auto-links a passwordless Google-created account whose Google email was verified', async () => {
      mocks.users.push({
        id: 'u-google', email: 'person@example.test', name: 'G',
        signupProvider: 'google', googleEmailVerified: true, googleSub: 'g-1',
      });
      const res = await exchange();
      expect(res.status).toBe(200);
      expect((await res.json()).user.id).toBe('u-google');
      expect(mocks.users[0]).toMatchObject({ ideaflowIdentityKey: KEY('sub-new'), ideaflowLinkedVia: 'google-proof' });
      expect(mocks.users).toHaveLength(1);
      // The second sign-in is the exact mapping: no confirmation, same account.
      expect((await (await exchange()).json()).user.id).toBe('u-google');
    });

    it.each([
      ['Apple-created', { signupProvider: 'apple', googleEmailVerified: true, googleSub: 'g' }],
      ['Google email not verified', { signupProvider: 'google', googleEmailVerified: false, googleSub: 'g' }],
      ['Google flag is the string "true"', { signupProvider: 'google', googleEmailVerified: 'true', googleSub: 'g' }],
      ['no Google subject', { signupProvider: 'google', googleEmailVerified: true }],
      ['typed legacy email, no proof', {}],
    ])('does not auto-link a passwordless account with weak proof (%s)', async (_label, extra) => {
      mocks.users.push({ id: 'u-weak', email: 'person@example.test', name: 'W', ...extra });
      const res = await exchange();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('link_required');
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();
    });

    it('a Google-created account that also has a password asks for the password instead', async () => {
      mocks.users.push({
        id: 'u-both', email: 'person@example.test', name: 'B', passwordHash: 'x',
        signupProvider: 'google', googleEmailVerified: true, googleSub: 'g',
      });
      const res = await exchange();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('confirm_required');
    });

    it('refuses ambiguity (case-variant duplicates) instead of picking one', async () => {
      mocks.users.push(
        passwordUser({ id: 'a', email: 'Person@example.test' }),
        passwordUser({ id: 'b', email: 'person@EXAMPLE.test' }),
      );
      const res = await exchange();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('link_required');
      expect(mocks.users.every(u => u.ideaflowIdentityKey === undefined)).toBe(true);
    });

    it('refuses an account already connected to a different Ideaflow subject', async () => {
      mocks.users.push(passwordUser({
        ideaflowIssuer: ISSUER, ideaflowSub: 'someone-else', ideaflowIdentityKey: KEY('someone-else'),
      }));
      const res = await exchange();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('already_linked');
    });

    it('never links a privileged account by password or Google proof', async () => {
      mocks.users.push(passwordUser({ role: 'admin' }));
      const res = await exchange();
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('needs_admin_proof');
      mocks.users.length = 0;
      mocks.users.push({
        id: 'g-admin', email: 'person@example.test', role: 'admin',
        signupProvider: 'google', googleEmailVerified: true, googleSub: 'g',
      });
      const res2 = await exchange();
      expect(res2.status).toBe(403);
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();
    });
  });

  describe('one-time ownership check inside sign-in', () => {
    async function startConfirm(): Promise<string> {
      const res = await exchange();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('confirm_required');
      expect(body.email).toBe('P***@Example.test');
      expect(JSON.stringify(body)).not.toContain('person@example.test');
      return body.confirmId as string;
    }

    it('links and signs in only after the right password, once, keeping the same local user', async () => {
      mocks.users.push(passwordUser());
      const confirmId = await startConfirm();
      mocks.verifyPassword.mockResolvedValueOnce({ status: 'ok', userId: 'someone-else' });
      const wrong = await confirm(confirmId);
      expect(wrong.status).toBe(401);
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();

      mocks.verifyPassword.mockResolvedValueOnce({ status: 'ok', userId: 'u-pass' });
      const ok = await confirm(confirmId);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.user.id).toBe('u-pass');
      expect(jwt.verify(body.token, 'dev-secret-change-me')).toMatchObject({ userId: 'u-pass' });
      expect(mocks.users).toHaveLength(1);
      expect(mocks.users[0]).toMatchObject({ ideaflowIdentityKey: KEY('sub-new'), ideaflowLinkedVia: 'password' });

      // Replay of the used check is refused.
      mocks.verifyPassword.mockResolvedValue({ status: 'ok', userId: 'u-pass' });
      expect((await confirm(confirmId)).status).toBe(410);
    });

    it('answers wrong and unverifiable attempts identically and unknown ids as expired', async () => {
      mocks.users.push(passwordUser());
      const confirmId = await startConfirm();
      mocks.verifyPassword.mockResolvedValue({ status: 'invalid' });
      const wrong = await confirm(confirmId);
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: 'That password did not match.', code: 'confirm_invalid' });
      expect((await confirm('x'.repeat(43))).status).toBe(410);
    });

    it('caps attempts per check and per account', async () => {
      mocks.users.push(passwordUser());
      mocks.verifyPassword.mockResolvedValue({ status: 'invalid' });
      const first = await startConfirm();
      for (let i = 0; i < 5; i += 1) expect((await confirm(first)).status).toBe(401);
      // The fifth failure burns the check: it cannot be tried again.
      expect((await confirm(first)).status).toBe(410);
      // A fresh check for the same account shares the account-wide cap.
      const second = await startConfirm();
      for (let i = 0; i < 5; i += 1) expect((await confirm(second)).status).toBe(401);
      const third = await startConfirm();
      expect((await confirm(third)).status).toBe(429);
      expect(mocks.verifyPassword).toHaveBeenCalledTimes(10);
    });

    it('does not count an unavailable password service as a wrong password', async () => {
      mocks.users.push(passwordUser());
      const confirmId = await startConfirm();
      mocks.verifyPassword.mockResolvedValue({ status: 'unavailable' });
      for (let i = 0; i < 5; i += 1) {
        const res = await confirm(confirmId);
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('confirm_unavailable');
      }
      // Nothing was spent: the right password still works afterwards.
      mocks.verifyPassword.mockResolvedValue({ status: 'ok', userId: 'u-pass' });
      expect((await confirm(confirmId)).status).toBe(200);
    });

    it('bounds refunds so an outage is not a free request loop', async () => {
      mocks.users.push(passwordUser());
      const confirmId = await startConfirm();
      mocks.verifyPassword.mockResolvedValue({ status: 'unavailable' });
      // Five refunded outcomes, then five that are charged, then the check is spent.
      for (let i = 0; i < 10; i += 1) expect((await confirm(confirmId)).status).toBe(503);
      expect((await confirm(confirmId)).status).toBe(429);
    });

    it('fails closed without calling anything when production has no NOOS_URL', async () => {
      mocks.users.push(passwordUser());
      const confirmId = await startConfirm();
      const env = { nodeEnv: process.env.NODE_ENV, noos: process.env.NOOS_URL };
      process.env.NODE_ENV = 'production';
      delete process.env.NOOS_URL;
      try {
        const res = await confirm(confirmId);
        expect(res.status).toBe(503);
        expect(mocks.verifyPassword).not.toHaveBeenCalled();
      } finally {
        if (env.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.nodeEnv;
        if (env.noos === undefined) delete process.env.NOOS_URL; else process.env.NOOS_URL = env.noos;
      }
    });

    it('charges concurrent guesses against the account up front', async () => {
      mocks.users.push(passwordUser());
      const ids = await Promise.all(Array.from({ length: 6 }, () => startConfirm()));
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      mocks.verifyPassword.mockImplementation(async () => { await gate; return { status: 'invalid' }; });
      // Six parked checks each fire two guesses at once, before any verdict lands.
      const inflight = ids.flatMap(id => [confirm(id), confirm(id)]);
      await new Promise(resolve => setTimeout(resolve, 100));
      release();
      const statuses = (await Promise.all(inflight)).map(r => r.status);
      expect(statuses.filter(s => s === 401)).toHaveLength(10);
      expect(statuses.filter(s => s === 429)).toHaveLength(2);
      expect(mocks.verifyPassword).toHaveBeenCalledTimes(10);
    });

    it('re-validates at confirm time: bound elsewhere meanwhile, or a second matching account appeared', async () => {
      mocks.users.push(passwordUser());
      mocks.verifyPassword.mockResolvedValue({ status: 'ok', userId: 'u-pass' });
      const first = await startConfirm();
      mocks.users[0].ideaflowIdentityKey = KEY('raced-subject');
      expect((await confirm(first)).status).toBe(401);

      mocks.users[0].ideaflowIdentityKey = undefined;
      const second = await startConfirm();
      mocks.users.push(passwordUser({ id: 'u-second', email: 'person@EXAMPLE.test' }));
      expect((await confirm(second)).status).toBe(401);
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
    });

    it('cannot be completed for a target that became privileged', async () => {
      mocks.users.push(passwordUser());
      mocks.verifyPassword.mockResolvedValue({ status: 'ok', userId: 'u-pass' });
      const confirmId = await startConfirm();
      mocks.users[0].role = 'admin';
      expect((await confirm(confirmId)).status).toBe(401);
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();
    });

    it('keeps enforcing the cohort at confirm time', async () => {
      mocks.users.push(passwordUser());
      const confirmId = await startConfirm();
      process.env.IDEAFLOW_ID_COHORT_ALLOWLIST = 'someone-else@example.test';
      expect((await confirm(confirmId)).status).toBe(403);
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
    });
  });

  describe('Use another Ideaflow account, cancelled sign-in and explicit Connect', () => {
    const start = (query = '') => fetch(
      `${baseUrl}/api/auth/ideaflow/url?state=${STATE}&nonce=${NONCE}&code_challenge=${CHALLENGE}${query}`,
    );

    it('forwards prompt=login only for the exact switch=1 and nothing else the caller sends', async () => {
      const cases: Array<[string, string | undefined]> = [
        ['', undefined],
        ['&switch=0', undefined],
        ['&switch=true', undefined],
        ['&switch=1', 'login'],
        ['&switch=1&prompt=none&max_age=0&login_hint=x%40y.test&scope=admin', 'login'],
        ['&prompt=login', undefined],
      ];
      for (const [query, prompt] of cases) {
        mocks.buildAuthorizationUrl.mockClear();
        expect((await start(query)).status).toBe(200);
        expect(mocks.buildAuthorizationUrl.mock.calls[0][1]).toEqual({
          state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, prompt,
        });
      }
    });

    it('a cancelled or failed provider exchange creates and links nothing', async () => {
      mocks.users.push(passwordUser());
      mocks.exchangeAuthorizationCode.mockRejectedValue(new Error('access_denied'));
      const res = await exchange();
      expect(res.status).toBe(401);
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();
      expect(mocks.users).toHaveLength(1);
    });

    function sessionHeaders(userId: string, email: string) {
      const token = jwt.sign({ userId, email, sessionId: 's' }, 'dev-secret-change-me', { expiresIn: '1h' });
      return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    }
    const linkStart = (headers: Record<string, string>, state: string) => fetch(
      `${baseUrl}/api/auth/ideaflow/link/url?state=${state}&nonce=${NONCE}&code_challenge=${CHALLENGE}`,
      { headers },
    );
    const linkExchange = (headers: Record<string, string>, state: string) => fetch(
      `${baseUrl}/api/auth/ideaflow/link/exchange`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: 'valid-looking-code', codeVerifier: VERIFIER, nonce: NONCE, state }),
      },
    );

    it('explicit Connect forces prompt=login and requires a fresh auth_time', async () => {
      mocks.users.push({ id: 'u-session', email: 'session@example.test', name: 'S' });
      const headers = sessionHeaders('u-session', 'session@example.test');
      expect((await linkStart(headers, STATE)).status).toBe(200);
      expect(mocks.buildAuthorizationUrl.mock.calls[0][1]).toMatchObject({ prompt: 'login' });

      mocks.exchangeAuthorizationCode.mockResolvedValue(
        identity({ email: 'idp@example.test', authTime: Math.floor(Date.now() / 1000) - 86_400 }),
      );
      const stale = await linkExchange(headers, STATE);
      expect(stale.status).toBe(403);
      expect((await stale.json()).code).toBe('stale_authentication');
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();

      const state2 = 'state2.' + 's'.repeat(30);
      await linkStart(headers, state2);
      mocks.exchangeAuthorizationCode.mockResolvedValue(identity({ email: 'idp@example.test' }));
      const ok = await linkExchange(headers, state2);
      expect(ok.status).toBe(200);
      expect(mocks.users[0].ideaflowIdentityKey).toBe(KEY('sub-new'));
    });

    it('explicit Connect on a password account cannot mint trusted provenance; sign-in still proves the password', async () => {
      mocks.users.push(passwordUser({ id: 'u-conn', email: 'conn@example.test' }));
      const headers = sessionHeaders('u-conn', 'conn@example.test');
      await linkStart(headers, STATE);
      mocks.exchangeAuthorizationCode.mockResolvedValue(identity({ email: 'idp@example.test' }));
      expect((await linkExchange(headers, STATE)).status).toBe(200);
      expect(mocks.users[0].ideaflowIdentityKey).toBe(KEY('sub-new'));
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();

      // Signing in with that mapping is NOT seamless: it asks for the password once.
      const res = await exchange();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('confirm_required');
      expect(body.token).toBeUndefined();
      mocks.verifyPassword.mockResolvedValue({ status: 'ok', userId: 'u-conn' });
      expect((await confirm(body.confirmId)).status).toBe(200);
      expect(mocks.users[0].ideaflowLinkedVia).toBe('password');
    });

    it('explicit Connect on a passwordless account is unchanged and records no provenance', async () => {
      mocks.users.push({ id: 'u-nopw', email: 'nopw@example.test', name: 'N' });
      const headers = sessionHeaders('u-nopw', 'nopw@example.test');
      await linkStart(headers, STATE);
      mocks.exchangeAuthorizationCode.mockResolvedValue(identity({ email: 'idp@example.test' }));
      expect((await linkExchange(headers, STATE)).status).toBe(200);
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();
      expect((await exchange()).status).toBe(200);
    });

    it('explicit Connect refuses a privileged account', async () => {
      mocks.users.push({ id: 'u-admin', email: 'admin@example.test', role: 'admin' });
      const headers = sessionHeaders('u-admin', 'admin@example.test');
      await linkStart(headers, STATE);
      const res = await linkExchange(headers, STATE);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('needs_admin_proof');
    });
  });

  describe('unproven and privileged mappings (shared-identity rules with Noos)', () => {
    const mapped = (over: Record<string, unknown> = {}) => passwordUser({
      id: 'u-map', ideaflowIssuer: ISSUER, ideaflowSub: 'sub-new', ideaflowIdentityKey: KEY('sub-new'), ...over,
    });
    const withAttested = (pairs: unknown) => { process.env.IDEAFLOW_ID_ATTESTED_PAIRS = JSON.stringify(pairs); };

    it.each([
      ['password proof', 'password'],
      ['google proof', 'google-proof'],
      ['pilot proof written by Noos', 'pilot'],
    ])('a mapping with trusted %s stays seamless on a password account', async (_label, via) => {
      mocks.users.push(mapped({ ideaflowLinkedVia: via }));
      const res = await exchange();
      expect(res.status).toBe(200);
      expect((await res.json()).user.id).toBe('u-map');
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
    });

    it.each([
      ['legacy (no provenance)', undefined],
      ['an unknown provenance value', 'explicit'],
      ['a non-string provenance', true],
    ])('an unproven mapping (%s) on a password account needs the password once, then is trusted', async (_label, via) => {
      mocks.users.push(mapped({ ideaflowLinkedVia: via }));
      const res = await exchange();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'confirm_required', email: 'P***@Example.test' });
      expect(body.token).toBeUndefined();

      // Wrong proof never mints a session and leaves the mapping unproven.
      mocks.verifyPassword.mockResolvedValueOnce({ status: 'invalid' });
      const wrong = await confirm(body.confirmId);
      expect(wrong.status).toBe(401);
      expect((await wrong.json()).token).toBeUndefined();
      expect(mocks.users[0].ideaflowLinkedVia).toBe(via);

      mocks.verifyPassword.mockResolvedValueOnce({ status: 'ok', userId: 'u-map' });
      const ok = await confirm(body.confirmId);
      expect(ok.status).toBe(200);
      expect((await ok.json()).user.id).toBe('u-map');
      expect(mocks.users).toHaveLength(1);
      expect(mocks.users[0].ideaflowLinkedVia).toBe('password');
      // Same local user, same mapping, and the next sign-in is the fast path.
      expect(mocks.users[0].ideaflowIdentityKey).toBe(KEY('sub-new'));
      mocks.verifyPassword.mockClear();
      expect((await exchange()).status).toBe(200);
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
    });

    it('an unproven mapping on a passwordless (or empty-hash-only) account still signs in', async () => {
      mocks.users.push(mapped({ passwordHash: undefined }));
      expect((await exchange()).status).toBe(200);
      mocks.users.length = 0;
      // An empty hash is not a password: Noos would set one for any caller.
      mocks.users.push(mapped({ passwordHash: '' }));
      expect((await exchange()).status).toBe(200);
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();
    });

    it('never trusts an empty password hash as a way to bind an identity by email', async () => {
      mocks.users.push(passwordUser({ passwordHash: '' }));
      const res = await exchange();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('link_required');
    });

    it('re-proving cannot be completed if the mapping moved or the account became privileged meanwhile', async () => {
      mocks.users.push(mapped());
      const first = (await (await exchange()).json()).confirmId as string;
      mocks.verifyPassword.mockResolvedValue({ status: 'ok', userId: 'u-map' });
      mocks.users[0].ideaflowIdentityKey = KEY('someone-else');
      expect((await confirm(first)).status).toBe(401);

      mocks.users[0].ideaflowIdentityKey = KEY('sub-new');
      const second = (await (await exchange()).json()).confirmId as string;
      mocks.users[0].role = 'admin';
      expect((await confirm(second)).status).toBe(401);
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();
    });

    it('never downgrades or replaces an existing trusted proof when a password proof lands', async () => {
      mocks.users.push(mapped({ ideaflowLinkedVia: 'google-proof' }));
      // Trusted already, so no confirm; the value stays.
      expect((await exchange()).status).toBe(200);
      expect(mocks.users[0].ideaflowLinkedVia).toBe('google-proof');
    });

    it('the Google proof is re-checked under the bind lock: an account that gained a password is not bound', async () => {
      mocks.users.push({
        id: 'u-race', email: 'race@example.test', passwordHash: 'x',
        signupProvider: 'google', googleEmailVerified: true, googleSub: 'g',
      });
      const { bindIdeaflowIdentityToUser } = await import('../src/routes/auth.js');
      const session = { executeWrite: async (fn: (tx: unknown) => Promise<unknown>) => fn({ run: async (q: string, p: Record<string, unknown>) => fakeRun(q, p) }) };
      await expect(bindIdeaflowIdentityToUser(session as never, 'u-race', identity(), 'google-proof'))
        .rejects.toThrow('IDEAFLOW_LINK_REQUIRED');
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();
    });

    it('a fresh bind never inherits a stale provenance left on the node', async () => {
      mocks.users.push({ id: 'u-stale', email: 'stale@example.test', ideaflowLinkedVia: 'google-proof' });
      const { bindIdeaflowIdentityToUser } = await import('../src/routes/auth.js');
      const session = { executeWrite: async (fn: (tx: unknown) => Promise<unknown>) => fn({ run: async (q: string, p: Record<string, unknown>) => fakeRun(q, p) }) };
      await bindIdeaflowIdentityToUser(session as never, 'u-stale', identity(), 'explicit');
      expect(mocks.users[0].ideaflowIdentityKey).toBe(KEY('sub-new'));
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();
    });

    it('a privileged account is not reachable through a mapping alone', async () => {
      mocks.users.push(mapped({ role: 'admin', ideaflowLinkedVia: 'password' }));
      const res = await exchange();
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('needs_admin_proof');
    });

    it('the deployer-attested pair keeps signing in, privileged or unproven, without a password', async () => {
      withAttested([{ userId: 'u-map', sub: 'sub-new' }]);
      mocks.users.push(mapped({ role: 'admin' }));
      const res = await exchange();
      expect(res.status).toBe(200);
      expect((await res.json()).user.id).toBe('u-map');
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
      // Attestation records nothing in the shared graph.
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();

      mocks.users.length = 0;
      mocks.users.push(mapped());
      expect((await exchange()).status).toBe(200);
    });

    it.each([
      ['wrong user id', [{ userId: 'other', sub: 'sub-new' }]],
      ['wrong subject', [{ userId: 'u-map', sub: 'other' }]],
      ['malformed JSON shape', [{ userId: 'u-map' }]],
      ['not an array', { userId: 'u-map', sub: 'sub-new' }],
    ])('an attested pair that does not match exactly (%s) grants nothing', async (_label, pairs) => {
      withAttested(pairs);
      mocks.users.push(mapped({ role: 'admin' }));
      expect((await exchange()).status).toBe(403);
    });

    it('attestation cannot be created from the graph or from an unmapped identity', async () => {
      withAttested([{ userId: 'u-admin', sub: 'sub-new' }]);
      // Unmapped privileged account: attestation only exempts an EXISTING mapping.
      mocks.users.push({ id: 'u-admin', email: 'person@example.test', role: 'admin', passwordHash: 'x' });
      const res = await exchange();
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('needs_admin_proof');
      expect(mocks.users[0].ideaflowIdentityKey).toBeUndefined();
    });

    it('cancelled or failed provider sign-in leaves an unproven mapping exactly as it was', async () => {
      mocks.users.push(mapped());
      mocks.exchangeAuthorizationCode.mockRejectedValue(new Error('access_denied'));
      expect((await exchange()).status).toBe(401);
      expect(mocks.users[0].ideaflowLinkedVia).toBeUndefined();
      expect(mocks.users[0].ideaflowIdentityKey).toBe(KEY('sub-new'));
    });
  });
});
