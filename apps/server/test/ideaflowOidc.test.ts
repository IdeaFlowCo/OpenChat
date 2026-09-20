import { describe, expect, it, vi } from 'vitest';
import {
  buildIdeaflowAuthorizationUrl,
  exchangeIdeaflowAuthorizationCode,
  getIdeaflowOidcConfig,
  IdeaflowOidcConfig,
} from '../src/services/ideaflowOidc.js';

const config: IdeaflowOidcConfig = {
  issuer: 'https://id.example.test/api/auth',
  clientId: 'openchat-web',
  clientSecret: 'server-only-secret',
  redirectUri: 'https://chat.example.test/auth/ideaflow/callback',
};

const discovery = {
  issuer: config.issuer,
  authorization_endpoint: `${config.issuer}/oauth2/authorize`,
  token_endpoint: `${config.issuer}/oauth2/token`,
  jwks_uri: `${config.issuer}/jwks`,
};

describe('getIdeaflowOidcConfig', () => {
  it('stays disabled until both the rollout flag and all confidential-client values exist', () => {
    expect(getIdeaflowOidcConfig({})).toBeNull();
    expect(getIdeaflowOidcConfig({ IDEAFLOW_ID_ENABLED: 'true' })).toBeNull();
    expect(getIdeaflowOidcConfig({
      IDEAFLOW_ID_ENABLED: 'false',
      IDEAFLOW_ID_CLIENT_ID: 'client',
      IDEAFLOW_ID_CLIENT_SECRET: 'secret',
      IDEAFLOW_ID_REDIRECT_URI: 'https://chat.example.test/callback',
    })).toBeNull();
  });

  it('returns a validated config without exposing a default client secret', () => {
    expect(getIdeaflowOidcConfig({
      IDEAFLOW_ID_ENABLED: 'true',
      IDEAFLOW_ID_CLIENT_ID: 'client',
      IDEAFLOW_ID_CLIENT_SECRET: 'secret',
      IDEAFLOW_ID_REDIRECT_URI: 'https://chat.example.test/callback',
    })).toEqual({
      issuer: 'https://id.ideaflow.app/api/auth',
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://chat.example.test/callback',
    });
  });
});

describe('buildIdeaflowAuthorizationUrl', () => {
  it('uses discovery and includes state, nonce, exact redirect URI, and S256 PKCE', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(discovery), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const result = await buildIdeaflowAuthorizationUrl(config, {
      state: 'state-value-1234567890',
      nonce: 'nonce-value-1234567890',
      codeChallenge: 'A'.repeat(43),
    }, fetchImpl);
    const url = new URL(result);

    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe('state-value-1234567890');
    expect(url.searchParams.get('nonce')).toBe('nonce-value-1234567890');
    expect(url.searchParams.get('code_challenge')).toBe('A'.repeat(43));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('rejects discovery documents whose issuer does not exactly match', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ...discovery,
      issuer: 'https://attacker.example.test',
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(buildIdeaflowAuthorizationUrl(config, {
      state: 'state-value-1234567890',
      nonce: 'nonce-value-1234567890',
      codeChallenge: 'A'.repeat(43),
    }, fetchImpl)).rejects.toThrow('OIDC discovery document is invalid');
  });
});

describe('exchangeIdeaflowAuthorizationCode', () => {
  it('exchanges confidentially, verifies ID-token claims, and returns the stable issuer+subject key', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(discovery), { status: 200 });
      }
      return new Response(JSON.stringify({ id_token: 'signed-id-token' }), { status: 200 });
    }) as unknown as typeof fetch;
    const verifyToken = vi.fn(async () => ({
      iss: config.issuer,
      aud: config.clientId,
      sub: 'stable-person-123',
      email: 'Person@Example.test',
      email_verified: true,
      nonce: 'nonce-value-1234567890',
      name: 'Person Example',
      picture: 'https://images.example.test/person.jpg',
    }));

    const identity = await exchangeIdeaflowAuthorizationCode(config, {
      code: 'authorization-code',
      codeVerifier: 'v'.repeat(64),
      nonce: 'nonce-value-1234567890',
    }, fetchImpl, verifyToken);

    expect(identity).toEqual({
      issuer: config.issuer,
      subject: 'stable-person-123',
      email: 'person@example.test',
      emailVerified: true,
      name: 'Person Example',
      picture: 'https://images.example.test/person.jpg',
      authTime: null,
    });
    const tokenRequest = fetchImpl.mock.calls[1];
    expect(tokenRequest[0]).toBe(discovery.token_endpoint);
    expect(tokenRequest[1]?.method).toBe('POST');
    expect(String(tokenRequest[1]?.body)).toContain('code_verifier=');
    const authorization = new Headers(tokenRequest[1]?.headers).get('authorization');
    expect(authorization).toMatch(/^Basic /);
    expect(Buffer.from(authorization!.slice(6), 'base64').toString('utf8')).toBe(
      `${config.clientId}:${config.clientSecret}`,
    );
  });

  it('rejects a validly signed token when its nonce does not match the initiating browser', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(JSON.stringify(
        url.endsWith('/.well-known/openid-configuration')
          ? discovery
          : { id_token: 'signed-id-token' },
      ), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(exchangeIdeaflowAuthorizationCode(config, {
      code: 'authorization-code',
      codeVerifier: 'v'.repeat(64),
      nonce: 'expected-nonce-123456',
    }, fetchImpl, async () => ({
      sub: 'stable-person-123',
      email: 'person@example.test',
      email_verified: true,
      nonce: 'different-nonce-12345',
    }))).rejects.toThrow('OIDC nonce mismatch');
  });

  it('requires the provider to attest that the email is verified', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(JSON.stringify(
        url.endsWith('/.well-known/openid-configuration')
          ? discovery
          : { id_token: 'signed-id-token' },
      ), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(exchangeIdeaflowAuthorizationCode(config, {
      code: 'authorization-code',
      codeVerifier: 'v'.repeat(64),
      nonce: 'nonce-value-1234567890',
    }, fetchImpl, async () => ({
      sub: 'stable-person-123',
      email: 'person@example.test',
      email_verified: false,
      nonce: 'nonce-value-1234567890',
    }))).rejects.toThrow('verified email identity');
  });
});
