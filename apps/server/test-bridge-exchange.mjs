import assert from 'node:assert/strict';
import test, { after, afterEach, before } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'bridge-test-jwt-secret';
const BRIDGE_SECRET = 'bridge-test-peer-secret';
const users = new Map();
const databaseCalls = [];
let server;
let baseUrl;

function fakeDriverProvider() {
  return {
    session() {
      return {
        async run(query, params) {
          databaseCalls.push({ query, params });

          let user = users.get(params.email);
          if (!user) {
            user = {
              id: params.id,
              email: params.email,
              name: params.name ?? params.email,
              avatarUrl: params.avatarUrl,
              signupProvider: query.includes("u.signupProvider = 'social-bridge'")
                ? 'social-bridge'
                : undefined,
            };
            users.set(params.email, user);
          }

          return {
            records: [{
              get(key) {
                assert.equal(key, 'user');
                return {
                  id: user.id,
                  email: user.email,
                  name: user.name,
                };
              },
            }],
          };
        },
        async close() {},
      };
    },
  };
}

async function postBridge(body, secret = BRIDGE_SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) {
    headers.Authorization = `Bearer ${secret}`;
  }
  return fetch(`${baseUrl}/api/auth/bridge-exchange`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

before(async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  const { createBridgeExchangeHandler } = await import('./dist/routes/auth.js');
  const app = express();
  app.use(express.json());
  app.post(
    '/api/auth/bridge-exchange',
    createBridgeExchangeHandler(fakeDriverProvider)
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterEach(() => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  delete process.env.OC_BRIDGE_SECRET;
  delete process.env.JWT_SECRET;
});

test('returns 503 without creating a user when the bridge is unconfigured', async () => {
  delete process.env.OC_BRIDGE_SECRET;
  const callsBefore = databaseCalls.length;

  const response = await postBridge({
    email: 'unconfigured@example.com',
    app: 'social',
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.token, undefined);
  assert.equal(users.has('unconfigured@example.com'), false);
  assert.equal(databaseCalls.length, callsBefore);
});

test('returns 401 for a missing or incorrect bearer secret', async () => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;

  for (const secret of [null, 'incorrect-secret']) {
    const response = await postBridge({
      email: 'unauthorized@example.com',
      app: 'social',
    }, secret);
    assert.equal(response.status, 401);
  }

  assert.equal(users.has('unauthorized@example.com'), false);
});

test('returns 400 for a missing or malformed email', async () => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;

  for (const email of [undefined, '', 'not-an-email', 'missing-domain@']) {
    const response = await postBridge({ email, app: 'social' });
    assert.equal(response.status, 400);
  }
});

test('provisions a new user and mints a JWT with the default 24h ttl', async () => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;

  const response = await postBridge({
    email: 'new-user@example.com',
    name: 'New User',
    avatarUrl: 'https://example.com/avatar.png',
    app: 'social',
  });
  const body = await response.json();
  const decoded = jwt.verify(body.token, JWT_SECRET);
  const storedUser = users.get('new-user@example.com');

  assert.equal(response.status, 201);
  assert.match(body.user.id, /^[A-Za-z0-9_-]{21}$/);
  assert.deepEqual(body.user, {
    id: storedUser.id,
    email: 'new-user@example.com',
    name: 'New User',
  });
  assert.equal(storedUser.signupProvider, 'social-bridge');
  assert.equal(decoded.userId, body.user.id);
  assert.equal(decoded.email, 'new-user@example.com');
  assert.equal(decoded.iss, 'openchat-bridge');
  assert.equal(decoded.app, 'social');
  assert.equal(decoded.exp - decoded.iat, 24 * 60 * 60);
});

test('MERGE is idempotent for the same email', async () => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;

  const first = await postBridge({
    email: 'idempotent@example.com',
    name: 'First Name',
    app: 'social',
  });
  const second = await postBridge({
    email: 'idempotent@example.com',
    name: 'Second Name',
    app: 'social',
  });
  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(secondBody.user.id, firstBody.user.id);
  assert.equal(secondBody.user.name, 'First Name');
});

test('provisionOnly provisions the user without returning a token', async () => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;

  const response = await postBridge({
    email: 'counterpart@example.com',
    app: 'social',
    provisionOnly: true,
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(Object.hasOwn(body, 'token'), false);
  assert.equal(body.user.email, 'counterpart@example.com');
  assert.equal(users.has('counterpart@example.com'), true);
});

test('caps a requested ttl above seven days at seven days', async () => {
  process.env.OC_BRIDGE_SECRET = BRIDGE_SECRET;

  const response = await postBridge({
    email: 'long-lived@example.com',
    app: 'social',
    ttl: '30d',
  });
  const body = await response.json();
  const decoded = jwt.verify(body.token, JWT_SECRET);

  assert.equal(response.status, 201);
  assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60);
});
