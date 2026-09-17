import express from 'express';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: vi.fn(),
      close: vi.fn(),
    }),
  }),
}));

import authRouter from '../src/routes/auth.js';

describe('IdeaFlow ID auth routes', () => {
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
    process.env.IDEAFLOW_ID_ENABLED = 'true';
    process.env.IDEAFLOW_ID_ISSUER = 'https://id.ideaflow.app/api/auth';
    process.env.IDEAFLOW_ID_CLIENT_ID = 'openchat-web';
    process.env.IDEAFLOW_ID_CLIENT_SECRET = 'server-secret';
    process.env.IDEAFLOW_ID_REDIRECT_URI = 'https://chat.globalbr.ai/auth/ideaflow/callback';
  });

  afterEach(() => {
    delete process.env.IDEAFLOW_ID_ENABLED;
    delete process.env.IDEAFLOW_ID_ISSUER;
    delete process.env.IDEAFLOW_ID_CLIENT_ID;
    delete process.env.IDEAFLOW_ID_CLIENT_SECRET;
    delete process.env.IDEAFLOW_ID_REDIRECT_URI;
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
});
