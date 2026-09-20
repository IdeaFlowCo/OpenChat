import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ideaflowWebCallbackRoutes, {
  buildIdeaflowWebCallbackRedirect,
} from '../src/routes/ideaflowWebCallback.js';

describe('IdeaFlow ID web callback redirect', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(ideaflowWebCallbackRoutes);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('preserves only OIDC response fields and adds an unambiguous provider marker', () => {
    expect(buildIdeaflowWebCallbackRedirect({
      code: 'one-time-code',
      state: 'expected-state',
      iss: 'https://id.ideaflow.app/api/auth',
      redirect: 'https://attacker.example.test',
      next: '//attacker.example.test',
    })).toBe(
      '/app/?provider=ideaflow&code=one-time-code&state=expected-state&iss=https%3A%2F%2Fid.ideaflow.app%2Fapi%2Fauth',
    );
  });

  it('redirects a success response to the fixed app path without caching', async () => {
    const response = await fetch(
      `${baseUrl}/auth/ideaflow/callback?code=abc&state=state-value&next=https://attacker.example.test`,
      { redirect: 'manual' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      '/app/?provider=ideaflow&code=abc&state=state-value',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('forwards an OIDC denial without inventing a navigation target', async () => {
    const response = await fetch(
      `${baseUrl}/auth/ideaflow/callback?error=access_denied&error_description=Nope&returnTo=//evil`,
      { redirect: 'manual' },
    );

    expect(response.headers.get('location')).toBe(
      '/app/?provider=ideaflow&error=access_denied&error_description=Nope',
    );
  });
});
