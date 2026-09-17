import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import googleWebCallbackRoutes, { buildGoogleWebCallbackRedirect } from '../src/routes/googleWebCallback.js';

const app = express();
app.use(googleWebCallbackRoutes);
const server = createServer(app);
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('buildGoogleWebCallbackRedirect', () => {
  it('preserves the authorization code and opaque state for the web app', () => {
    const redirect = buildGoogleWebCallbackRedirect({
      code: 'code/with+reserved=characters',
      state: 'state?with&opaque=value',
      scope: 'openid email profile',
    });

    const target = new URL(redirect, 'https://chat.globalbr.ai');
    expect(target.origin).toBe('https://chat.globalbr.ai');
    expect(target.pathname).toBe('/app/');
    expect(target.searchParams.get('code')).toBe('code/with+reserved=characters');
    expect(target.searchParams.get('state')).toBe('state?with&opaque=value');
    expect(target.searchParams.get('scope')).toBe('openid email profile');
  });

  it('preserves Google OAuth errors so the app can report them', () => {
    const redirect = buildGoogleWebCallbackRedirect({
      error: 'access_denied',
      error_description: 'The user declined access',
      state: 'expected-state',
    });

    const target = new URL(redirect, 'https://chat.globalbr.ai');
    expect(target.pathname).toBe('/app/');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('error_description')).toBe('The user declined access');
    expect(target.searchParams.get('state')).toBe('expected-state');
  });

  it('cannot be turned into an open redirect by navigation-like parameters', () => {
    const redirect = buildGoogleWebCallbackRedirect({
      code: 'safe-code',
      state: '//attacker.example/escape',
      next: 'https://attacker.example',
      redirect_uri: '//attacker.example',
      returnTo: 'https://attacker.example',
    });

    const target = new URL(redirect, 'https://chat.globalbr.ai');
    expect(target.origin).toBe('https://chat.globalbr.ai');
    expect(target.pathname).toBe('/app/');
    expect(target.searchParams.get('state')).toBe('//attacker.example/escape');
    expect(target.searchParams.has('next')).toBe(false);
    expect(target.searchParams.has('redirect_uri')).toBe(false);
    expect(target.searchParams.has('returnTo')).toBe(false);
  });

  it('falls back to the app root when Google sends no supported fields', () => {
    expect(buildGoogleWebCallbackRedirect({ next: 'https://attacker.example' })).toBe('/app/');
  });

  it('serves the registered callback as a non-cacheable temporary redirect', async () => {
    const response = await fetch(
      `${baseUrl}/auth/google/callback?code=google-code&state=csrf-state&next=https%3A%2F%2Fattacker.example`,
      { redirect: 'manual' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBe('/app/?code=google-code&state=csrf-state');
  });
});
