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

  it('bounces a native-marked response to the fixed app callback (code-xbh.14)', async () => {
    const response = await fetch(
      `${baseUrl}/auth/ideaflow/callback?code=abc&state=native-state-value&next=https://attacker.example.test`,
      { redirect: 'manual' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'openchat://auth/ideaflow/callback?provider=ideaflow&code=abc&state=native-state-value',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('bounces a native denial to the app so the auth session closes', () => {
    expect(buildIdeaflowWebCallbackRedirect({
      error: 'access_denied',
      state: 'native-xyz',
      redirect_uri: 'https://attacker.example.test',
    })).toBe('openchat://auth/ideaflow/callback?provider=ideaflow&state=native-xyz&error=access_denied');
  });

  it('keeps web states (including ones merely containing the marker) on the web path', () => {
    expect(buildIdeaflowWebCallbackRedirect({ code: 'c', state: 'abc-native-1' }))
      .toBe('/app/?provider=ideaflow&code=c&state=abc-native-1');
    expect(buildIdeaflowWebCallbackRedirect({ code: 'c', state: ['native-a', 'native-b'] }))
      .toBe('/app/?provider=ideaflow&code=c');
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
