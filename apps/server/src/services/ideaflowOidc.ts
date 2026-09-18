import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';

export const DEFAULT_IDEAFLOW_ID_ISSUER = 'https://id.ideaflow.app/api/auth';

export interface IdeaflowOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface IdeaflowIdentityClaims {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const discoveryCache = new Map<string, Promise<OidcDiscovery>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Ideaflow ID is deliberately opt-in. Supplying credentials alone is not
 * enough to expose the button or endpoints; the rollout flag must also be on.
 */
export function getIdeaflowOidcConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdeaflowOidcConfig | null {
  if (env.IDEAFLOW_ID_ENABLED !== 'true') return null;

  const issuer = trimTrailingSlash(
    env.IDEAFLOW_ID_ISSUER || DEFAULT_IDEAFLOW_ID_ISSUER,
  );
  const clientId = env.IDEAFLOW_ID_CLIENT_ID?.trim();
  const clientSecret = env.IDEAFLOW_ID_CLIENT_SECRET?.trim();
  const redirectUri = env.IDEAFLOW_ID_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) return null;
  if (!isHttpsUrl(issuer) || !isHttpsUrl(redirectUri)) return null;

  return { issuer, clientId, clientSecret, redirectUri };
}

async function fetchDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const discoveryUrl = `${trimTrailingSlash(issuer)}/.well-known/openid-configuration`;
  const response = await fetchImpl(discoveryUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`OIDC discovery failed with status ${response.status}`);
  }

  const document = await response.json() as Partial<OidcDiscovery>;
  if (
    document.issuer !== issuer
    || !document.authorization_endpoint
    || !document.token_endpoint
    || !document.jwks_uri
    || !isHttpsUrl(document.authorization_endpoint)
    || !isHttpsUrl(document.token_endpoint)
    || !isHttpsUrl(document.jwks_uri)
  ) {
    throw new Error('OIDC discovery document is invalid');
  }

  return document as OidcDiscovery;
}

export function getOidcDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  // Custom fetch implementations are used by tests and should not populate the
  // process-wide production cache.
  if (fetchImpl !== fetch) return fetchDiscovery(issuer, fetchImpl);

  const cached = discoveryCache.get(issuer);
  if (cached) return cached;

  const pending = fetchDiscovery(issuer, fetchImpl).catch((error) => {
    discoveryCache.delete(issuer);
    throw error;
  });
  discoveryCache.set(issuer, pending);
  return pending;
}

export async function buildIdeaflowAuthorizationUrl(
  config: IdeaflowOidcConfig,
  input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const discovery = await getOidcDiscovery(config.issuer, fetchImpl);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(url);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

export async function exchangeIdeaflowAuthorizationCode(
  config: IdeaflowOidcConfig,
  input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  },
  fetchImpl: typeof fetch = fetch,
  verifyToken: (
    idToken: string,
    discovery: OidcDiscovery,
    config: IdeaflowOidcConfig,
  ) => Promise<JWTPayload> = async (idToken, discovery, oidcConfig) => {
    const result = await jwtVerify(idToken, getJwks(discovery.jwks_uri), {
      issuer: oidcConfig.issuer,
      audience: oidcConfig.clientId,
      requiredClaims: ['sub', 'email', 'email_verified', 'nonce'],
    });
    return result.payload;
  },
): Promise<IdeaflowIdentityClaims> {
  const discovery = await getOidcDiscovery(config.issuer, fetchImpl);
  // Ideaflow ID's pinned Better Auth provider decodes the Basic payload and
  // splits on the first colon without an additional form-url-decode step.
  const credentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString('base64');
  const response = await fetchImpl(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: input.codeVerifier,
    }).toString(),
  });
  const token = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || !token.id_token) {
    throw new Error(
      token.error_description || token.error || `OIDC token exchange failed with status ${response.status}`,
    );
  }

  const payload = await verifyToken(token.id_token, discovery, config);
  if (payload.nonce !== input.nonce) {
    throw new Error('OIDC nonce mismatch');
  }
  if (
    typeof payload.sub !== 'string'
    || typeof payload.email !== 'string'
    || payload.email_verified !== true
  ) {
    throw new Error('IdeaFlow ID did not return a verified email identity');
  }

  return {
    issuer: config.issuer,
    subject: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: true,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  };
}
