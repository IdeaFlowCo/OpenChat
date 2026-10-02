import { describe, expect, it } from 'vitest';
import { buildIdeaflowAuthorizationUrl, type IdeaflowOidcConfig } from '../src/services/ideaflowOidc.js';

const issuer = 'https://id.example.test/api/auth';
const config = {
  issuer,
  clientId: 'client-1',
  clientSecret: 'unused',
  redirectUri: 'https://chat.example.test/auth/ideaflow/callback',
} as IdeaflowOidcConfig;

const discovery = (async () => new Response(JSON.stringify({
  issuer,
  authorization_endpoint: `${issuer}/oauth2/authorize`,
  token_endpoint: `${issuer}/oauth2/token`,
  jwks_uri: `${issuer}/jwks`,
}))) as unknown as typeof fetch;

const input = { state: 's'.repeat(43), nonce: 'n'.repeat(43), codeChallenge: 'c'.repeat(43) };

describe('buildIdeaflowAuthorizationUrl', () => {
  it('reuses the provider session by default', async () => {
    const url = new URL(await buildIdeaflowAuthorizationUrl(config, input, discovery));
    expect(url.searchParams.get('prompt')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('asks who is signing in after an explicit sign-out', async () => {
    const url = new URL(await buildIdeaflowAuthorizationUrl(config, { ...input, prompt: 'select_account' }, discovery));
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });
});
