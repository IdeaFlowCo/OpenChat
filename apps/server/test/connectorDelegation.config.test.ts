import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectorDelegation } from '../src/routes/connectorDelegation.js';

const callback = 'https://fixture.example.test/callback';
const verifier = 'A'.repeat(43);
const auth = 'Basic ' + Buffer.from('fixture:secret').toString('base64');
const startBody = { callback, connectorGrantId: 'grant', connectorUserId: 'notes-alice',
  scopes: ['openchat.read'], state: 'state',
  codeChallenge: createHash('sha256').update(verifier).digest('base64url') };

function appFromFinalConfiguration() {
  const delegation = createConnectorDelegation();
  const app = express();
  app.use(express.json());
  app.use('/api', delegation.guard);
  app.use('/api/connector-delegations', delegation.routes);
  app.get('/api/chat/conversations', (req, res) => res.json({ userId: req.user?.userId }));
  return app;
}

function loadDotenv(mode: string) {
  dotenv.populate(process.env, dotenv.parse([
    `NODE_ENV=${mode}`,
    'OPENCHAT_CONNECTOR_DELEGATION_ENABLED=true',
    `OPENCHAT_CONNECTOR_CLIENTS_JSON=${JSON.stringify([{ id: 'fixture', secret: 'secret', callbacks: [callback] }])}`,
  ].join('\n')), { override: true });
}

describe('delegation initialization after dotenv', () => {
  afterEach(() => vi.unstubAllEnvs());

  function initialEnvironment(mode: string) {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('OPENCHAT_CONNECTOR_DELEGATION_ENABLED', 'false');
    vi.stubEnv('OPENCHAT_CONNECTOR_CLIENTS_JSON', '[]');
  }

  it('uses dotenv client configuration for both code exchange and route authorization', async () => {
    initialEnvironment('production');
    const disabled = appFromFinalConfiguration();
    expect((await request(disabled).post('/api/connector-delegations/start').set('Authorization', auth)
      .send(startBody)).status).toBe(404);
    loadDotenv('test');
    const app = appFromFinalConfiguration();
    const started = await request(app).post('/api/connector-delegations/start').set('Authorization', auth).send(startBody);
    expect(started.status).toBe(200);
    const userAuth = 'Bearer ' + jwt.sign({ userId: 'alice', email: 'alice@example.test' },
      process.env.JWT_SECRET || 'dev-secret-change-me');
    expect((await request(app).get(started.body.reviewPath).set('Authorization', userAuth)).status).toBe(200);
    const consent = await request(app).post('/api/connector-delegations/consent').set('Authorization', userAuth)
      .send({ transaction: started.body.transaction, approvedScopes: ['openchat.read'] });
    expect(consent.status).toBe(303);
    const code = new URL(consent.headers.location).searchParams.get('code');
    const issued = await request(app).post('/api/connector-delegations/token').set('Authorization', auth)
      .send({ callback, code, state: 'state', codeVerifier: verifier });
    expect(issued.status).toBe(200);
    const authorized = await request(app).get('/api/chat/conversations')
      .set('Authorization', `Bearer ${issued.body.access_token}`);
    expect(authorized.status).toBe(200);
    expect(authorized.body).toEqual({ userId: 'alice' });
  });

  it('honors the final production override even when harness flags are enabled', async () => {
    initialEnvironment('test');
    loadDotenv('test');
    expect((await request(appFromFinalConfiguration()).post('/api/connector-delegations/start')
      .set('Authorization', auth).send(startBody)).status).toBe(200);
    loadDotenv('production');
    const app = appFromFinalConfiguration();
    expect((await request(app).post('/api/connector-delegations/start')
      .set('Authorization', auth).send(startBody)).status).toBe(404);
    expect((await request(app).get('/api/chat/conversations')
      .set('Authorization', 'Bearer ocd_fixture')).status).toBe(403);
  });
});
