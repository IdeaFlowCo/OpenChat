import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const google = vi.hoisted(() => ({ verify: vi.fn(), payload: {} as Record<string, unknown> }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: class { verifyIdToken = google.verify; },
}));
vi.mock('../src/services/assistant.js', () => ({ ensureAssistantConversation: vi.fn() }));

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('Google account binding (real Neo4j, mocked Google verification)', () => {
  const prefix = `google-binding-${Date.now()}-${Math.random().toString(36).slice(2)}-`;
  const accountId = `${prefix}legacy`;
  const email = `${prefix}person@example.test`;
  const subject = `${prefix}subject`;
  const app = express();
  let database: typeof import('../src/db.js');

  async function query(cypher: string, params: Record<string, unknown> = {}) {
    const session = database.getDriver().session();
    try { return await session.run(cypher, params); }
    finally { await session.close(); }
  }

  async function clean() {
    await query('MATCH (marker:GoogleBindingTestMarker) WHERE marker.id STARTS WITH $prefix DETACH DELETE marker', { prefix });
    await query(`MATCH (u:User)
      WHERE u.id STARTS WITH $prefix OR u.email STARTS WITH $prefix
        OR u.googleSub STARTS WITH $prefix
      DETACH DELETE u`, { prefix });
    await query(`MATCH (lock:OpenChatGoogleAuthLock)
      WHERE lock.key STARTS WITH $emailPrefix OR lock.key STARTS WITH $subPrefix
      DELETE lock`, { emailPrefix: `email:${prefix}`, subPrefix: `subject:${prefix}` });
  }

  beforeAll(async () => {
    vi.stubEnv('NEO4J_URI', uri!);
    vi.stubEnv('NEO4J_USER', user!);
    vi.stubEnv('NEO4J_PASSWORD', password!);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-web-client');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-web-secret');
    vi.stubEnv('GOOGLE_IOS_CLIENT_ID', 'test-ios-client');
    vi.stubEnv('JWT_SECRET', 'google-binding-test-secret');
    database = await import('../src/db.js');
    await database.initDatabase();
    const { default: router } = await import('../src/routes/auth.js');
    app.use(express.json());
    app.use('/api/auth', router);
  });

  beforeEach(async () => {
    await clean();
    google.payload = { sub: subject, email, email_verified: true, name: 'Test Person' };
    google.verify.mockReset().mockImplementation(async () => ({ getPayload: () => google.payload }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-access-token' }));
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(JSON.stringify(google.payload));
      }
      throw new Error(`Unexpected network request: ${url}`);
    }));
    await query('CREATE (:User {id: $id, email: $email, name: $name, googleSub: $sub})', {
      id: accountId, email, name: 'Original name', sub: subject,
    });
  });

  afterAll(async () => {
    if (database) {
      await clean();
      await database.closeDatabase();
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const route of ['idtoken-exchange', 'exchange']) {
    function signIn(options: { link?: unknown; bearer?: string; userId?: string } = {}) {
      const call = request(app).post(`/api/auth/google/${route}`);
      if (options.bearer) call.set('Authorization', `Bearer ${options.bearer}`);
      const proof = route === 'exchange'
        ? { code: 'mock-code', redirectUri: 'https://example.test/auth/google/callback' }
        : { idToken: 'mock-valid-id-token' };
      return call.send({ ...proof, link: options.link, userId: options.userId });
    }

    function accountSession(userId = accountId) {
      return jwt.sign({ userId, email }, 'google-binding-test-secret', { expiresIn: '5m' });
    }

    describe(route, () => {
      it('signs the existing account in with the matching Google subject', async () => {
        const response = await signIn();
        expect(response.status).toBe(200);
        expect(jwt.verify(response.body.token, 'google-binding-test-secret')).toMatchObject({ userId: accountId });
        if (route === 'idtoken-exchange') {
          expect(google.verify).toHaveBeenCalledWith({
            idToken: 'mock-valid-id-token', audience: ['test-ios-client', 'test-web-client'],
          });
        }
      });

      it.each([true, false])('denies a different subject with the same email (verified=%s)', async verified => {
        google.payload.sub = `${prefix}different-subject`;
        google.payload.email_verified = verified;
        const response = await signIn();
        // On the vulnerable baseline this assertion exposes the seeded
        // victim's ID in a real server-signed JWT, without logging the token.
        const claims = response.body.token
          ? jwt.verify(response.body.token, 'google-binding-test-secret')
          : undefined;
        expect(claims).toBeUndefined();
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        const stored = await query('MATCH (u:User {id: $id}) RETURN u.googleSub AS sub', { id: accountId });
        expect(stored.records[0].get('sub')).toBe(subject);
      });

      it('keeps the original account ID and contact email when the bound subject changes email', async () => {
        await query(`MATCH (u:User {id: $id})
          CREATE (u)-[:TEST_BINDING]->(:GoogleBindingTestMarker {id: $id})`, { id: accountId });
        google.payload.email = `${prefix}changed@example.test`;
        const response = await signIn();
        expect(response.status).toBe(200);
        expect(response.body.user).toMatchObject({ id: accountId, email, name: 'Original name' });
        expect(jwt.verify(response.body.token, 'google-binding-test-secret')).toMatchObject({ userId: accountId });
        const membership = await query(`MATCH (u:User {id: $id})-[:TEST_BINDING]->(marker:GoogleBindingTestMarker)
          RETURN marker.id AS markerId`, { id: accountId });
        expect(membership.records[0].get('markerId')).toBe(accountId);
      });

      it('prefers the bound subject even when its changed email belongs to another account', async () => {
        const otherEmail = `${prefix}other@example.test`;
        await query('CREATE (:User {id: $id, email: $email, googleSub: $sub})', {
          id: `${prefix}other`, email: otherEmail, sub: `${prefix}other-subject`,
        });
        google.payload.email = otherEmail;
        const response = await signIn();
        expect(response.status).toBe(200);
        expect(jwt.verify(response.body.token, 'google-binding-test-secret')).toMatchObject({ userId: accountId });
      });

      it('requires independent ownership proof for an unlinked email collision', async () => {
        await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
        const response = await signIn();
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        const stored = await query('MATCH (u:User {id: $id}) RETURN u.googleSub AS sub', { id: accountId });
        expect(stored.records[0].get('sub')).toBeNull();
      });

      it.each([false, undefined])('still authenticates a bound subject when email_verified=%s', async verified => {
        google.payload.email_verified = verified;
        google.payload.email = `${prefix}new-contact@example.test`;
        const response = await signIn();
        expect(response.status).toBe(200);
        expect(response.body.user).toMatchObject({ id: accountId, email });
      });

      it('accepts a bound subject without using email to identify it', async () => {
        delete google.payload.email;
        const response = await signIn();
        expect(response.status).toBe(200);
        expect(response.body.user.id).toBe(accountId);
      });

      it.each([false, undefined, 'true'])('rejects a new account when email_verified=%s', async verified => {
        google.payload.sub = `${prefix}new-subject`;
        google.payload.email = `${prefix}new@example.test`;
        google.payload.email_verified = verified;
        const response = await signIn();
        expect(response.status).toBe(400);
        expect(response.body.token).toBeUndefined();
        const created = await query('MATCH (u:User {googleSub: $sub}) RETURN u', { sub: google.payload.sub });
        expect(created.records).toHaveLength(0);
      });

      it('creates one account for a verified, previously unseen Google identity', async () => {
        google.payload.sub = `${prefix}new-subject`;
        google.payload.email = `${prefix}new@example.test`;
        const first = await signIn();
        const second = await signIn();
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.body.user.id).not.toBe(accountId);
        expect(second.body.user.id).toBe(first.body.user.id);
      });

      it('treats email case variants as a collision, never a new identity', async () => {
        google.payload.sub = `${prefix}different-subject`;
        google.payload.email = email.toUpperCase();
        const response = await signIn();
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
      });

      it('fails closed on legacy duplicate Google subjects', async () => {
        await query('CREATE (:User {id: $id, email: $email, googleSub: $sub})', {
          id: `${prefix}duplicate`, email: `${prefix}duplicate@example.test`, sub: subject,
        });
        const response = await signIn();
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
      });

      it.each([false, true])('fails closed on duplicate account IDs with a unique Google subject (bearer=%s)', async withBearer => {
        await query('CREATE (:User {id: $id, email: $email, googleSub: $sub})', {
          id: accountId, email: `${prefix}duplicate@example.test`, sub: `${prefix}other-subject`,
        });
        const snapshot = () => query(`MATCH (u:User {id: $id})
          RETURN elementId(u) AS nodeId, properties(u) AS properties ORDER BY nodeId`, { id: accountId });
        const before = await snapshot();
        const response = await signIn({ bearer: withBearer ? accountSession() : undefined });
        expect(Boolean(response.body.token)).toBe(false);
        expect(response.status).toBe(409);
        const after = await snapshot();
        expect(after.records.map(record => record.toObject()))
          .toEqual(before.records.map(record => record.toObject()));
      });

      it('refuses to choose among unlinked accounts with duplicate IDs', async () => {
        await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
        await query('CREATE (:User {id: $id, email: $email})', {
          id: accountId, email: `${prefix}duplicate@example.test`,
        });
        const response = await signIn({ bearer: accountSession() });
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        const stored = await query('MATCH (u:User {id: $id}) RETURN u.googleSub AS sub', { id: accountId });
        expect(stored.records.map(record => record.get('sub'))).toEqual([null, null]);
      });

      it('does not choose among duplicate legacy emails', async () => {
        await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
        await query('CREATE (:User {id: $id, email: $email})', { id: `${prefix}duplicate`, email });
        const response = await signIn();
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
      });

      it('rejects provider verification failure before database changes', async () => {
        if (route === 'idtoken-exchange') google.verify.mockRejectedValueOnce(new Error('Invalid proof'));
        else vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 401 }));
        const response = await signIn();
        expect(response.status).toBe(401);
        expect(response.body.token).toBeUndefined();
      });

      it('rejects a missing Google subject', async () => {
        delete google.payload.sub;
        const response = await signIn();
        expect(response.status).toBe(400);
        expect(response.body.token).toBeUndefined();
      });

      it.each([false, true])('rejects explicit linking even with a valid account bearer (already bound=%s)', async bound => {
        if (!bound) await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
        await query(`MATCH (u:User {id: $id})
          CREATE (u)-[:TEST_BINDING]->(:GoogleBindingTestMarker {id: $id})`, { id: accountId });
        const snapshot = () => query(`MATCH (u:User {id: $id})-[:TEST_BINDING]->(marker:GoogleBindingTestMarker)
          RETURN elementId(u) AS nodeId, properties(u) AS user, marker.id AS markerId`, { id: accountId });
        const before = await snapshot();
        // Session signatures do not establish how account access was obtained.
        google.payload.email = `${prefix}google-contact@example.test`;
        const response = await signIn({ link: true, bearer: accountSession(), userId: 'untrusted-body-id' });
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        expect(google.verify).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        const after = await snapshot();
        expect(after.records.map(record => record.toObject()))
          .toEqual(before.records.map(record => record.toObject()));
        const created = await query('MATCH (u:User {email: $email}) RETURN u', { email: google.payload.email });
        expect(created.records).toHaveLength(0);
      });

      it.each([undefined, 'invalid-session'])('rejects linking with a missing or invalid bearer (%s)', async bearer => {
        const response = await signIn({ link: true, bearer, userId: accountId });
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        expect(google.verify).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      });

      it.each(['true', 1, null])('rejects malformed link intent (%s)', async link => {
        const response = await signIn({ link, bearer: accountSession() });
        expect(response.status).toBe(400);
        expect(response.body.token).toBeUndefined();
        expect(google.verify).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      });

      it('does not link implicitly with an ambient session or body userId', async () => {
        await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
        const response = await signIn({ bearer: accountSession(), userId: accountId });
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
      });

      it('will not replace a stored subject even with an account session', async () => {
        google.payload.sub = `${prefix}different-subject`;
        const response = await signIn({ bearer: accountSession() });
        expect(response.status).toBe(409);
        const stored = await query('MATCH (u:User {id: $id}) RETURN u.googleSub AS sub', { id: accountId });
        expect(stored.records[0].get('sub')).toBe(subject);
      });

      it('ignores bearer and body target IDs when the Google subject already identifies an account', async () => {
        const otherId = `${prefix}other`;
        await query('CREATE (:User {id: $id, email: $email})', { id: otherId, email: `${prefix}other@example.test` });
        const response = await signIn({ bearer: accountSession(otherId), userId: otherId });
        expect(response.status).toBe(200);
        expect(jwt.verify(response.body.token, 'google-binding-test-secret')).toMatchObject({ userId: accountId });
        const stored = await query('MATCH (u:User {id: $id}) RETURN u.googleSub AS sub', { id: otherId });
        expect(stored.records[0].get('sub')).toBeNull();
      });

      it('does not reinterpret a link request as signup when no target exists', async () => {
        await clean();
        const response = await signIn({ link: true, bearer: accountSession() });
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        const created = await query('MATCH (u:User {googleSub: $sub}) RETURN u', { sub: subject });
        expect(created.records).toHaveLength(0);
      });

      it('rejects linking regardless of Google email verification', async () => {
        await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
        google.payload.email_verified = false;
        const response = await signIn({ link: true, bearer: accountSession() });
        expect(response.status).toBe(409);
        expect(response.body.token).toBeUndefined();
        const stored = await query('MATCH (u:User {id: $id}) RETURN u.googleSub AS sub', { id: accountId });
        expect(stored.records[0].get('sub')).toBeNull();
      });
    });
  }

  async function resolve(sub: string, googleEmail: string) {
    const { resolveGoogleIdentity } = await import('../src/services/googleIdentity.js');
    const session = database.getDriver().session();
    try {
      return await resolveGoogleIdentity(session, { sub, email: googleEmail, email_verified: true }, 'google');
    } finally {
      await session.close();
    }
  }

  it('serializes simultaneous first sign-ins for the same subject, including different emails', async () => {
    const sub = `${prefix}new-subject`;
    const users = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      resolve(sub, `${prefix}new-${i % 3}@example.test`)));
    expect(new Set(users.map(u => u.id)).size).toBe(1);
    const stored = await query('MATCH (u:User {googleSub: $sub}) RETURN u.id', { sub });
    expect(stored.records).toHaveLength(1);
  });

  it('allows only one of two different subjects racing to register the same email', async () => {
    const attempts = await Promise.allSettled([1, 2].map(i =>
      resolve(`${prefix}new-subject-${i}`, `${prefix}new@example.test`)));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(a => a.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    const stored = await query('MATCH (u:User {email: $email}) RETURN u.id', { email: `${prefix}new@example.test` });
    expect(stored.records).toHaveLength(1);
  });

  it('denies concurrent attempts to claim an unlinked legacy email without duplicating or migrating it', async () => {
    await query('MATCH (u:User {id: $id}) REMOVE u.googleSub', { id: accountId });
    const attempts = await Promise.allSettled([1, 2].map(i =>
      resolve(`${prefix}new-subject-${i}`, email)));
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected');
      expect((attempt as PromiseRejectedResult).reason.status).toBe(409);
    }
    const stored = await query('MATCH (u:User {email: $email}) RETURN u.id AS id, u.googleSub AS sub', { email });
    expect(stored.records).toHaveLength(1);
    expect(stored.records[0].get('id')).toBe(accountId);
    expect(stored.records[0].get('sub')).toBeNull();
  });
});
