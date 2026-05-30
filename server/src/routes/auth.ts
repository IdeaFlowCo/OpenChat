import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { requireAuth, AuthUser } from '../middleware/auth.js';

const router = Router();
function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-secret-change-me';
}
const NOOS_URL = process.env.NOOS_URL || 'http://localhost:52743';

// Google OAuth — see OpenChat-hwi epic. Client created in GCP project
// boreal-conquest-464203-v2; secret lives in server/.env (and on M5 at
// ~/.config/openchat-accounts.json for the human reference copy).
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
  refresh_token?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

// Helper to convert Neo4j types to JS
function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in (value as object) && 'year' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      result[k] = toJS(v);
    }
    return result;
  }
  return value;
}

/**
 * DEV LOGIN - For development/testing only
 * In production, replace with Noos SSO redirect
 *
 * POST /api/auth/dev-login
 * Body: { email: string, name?: string }
 *
 * Creates user if doesn't exist, returns JWT
 */
router.post('/dev-login', async (req: Request, res: Response) => {
  // Only allow in development
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'Dev login not available in production' });
    return;
  }

  const { email, name } = req.body;

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const session = getDriver().session();

  try {
    // Find or create user
    const now = new Date().toISOString();
    const result = await session.run(`
      MERGE (u:User {email: $email})
      ON CREATE SET
        u.id = $id,
        u.name = coalesce($name, $email),
        u.createdAt = datetime($now),
        u.presenceStatus = 'available',
        u.lastSeenAt = datetime($now)
      ON MATCH SET
        u.lastSeenAt = datetime($now),
        u.presenceStatus = 'available'
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .isBot } AS user
    `, {
      email,
      name: name || null,
      id: nanoid(),
      now
    });

    const user = toJS(result.records[0].get('user')) as { id: string; email: string; name: string };

    // Generate JWT (same format as Noos)
    const token = jwt.sign(
      { userId: user.id, email: user.email } as AuthUser,
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user,
      expiresIn: 7 * 24 * 60 * 60 // 7 days in seconds
    });
  } catch (error) {
    console.error('Error in dev login:', error);
    res.status(500).json({ error: 'Login failed' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/auth/me - Get current user info
 */
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .lastSeenAt, .isBot } AS user
    `, { userId });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = toJS(result.records[0].get('user'));
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/auth/logout - Mark user as offline
 * (Token invalidation would require a blocklist in production)
 */
router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    await session.run(`
      MATCH (u:User {id: $userId})
      SET u.presenceStatus = 'offline',
          u.lastSeenAt = datetime()
    `, { userId });

    res.json({ success: true });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: 'Logout failed' });
  } finally {
    await session.close();
  }
});

/**
 * PRODUCTION SSO (placeholder)
 *
 * GET /api/auth/login - Redirect to Noos login
 * Would redirect to: ${NOOS_URL}/auth/authorize?redirect_uri=...&client_id=openchat
 */
router.get('/login', (req: Request, res: Response) => {
  const defaultBase = process.env.OPENCHAT_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';
  const fallbackRedirect = `${defaultBase.replace(/\/$/, '')}/auth/callback`;
  const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : fallbackRedirect;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;

  const authorizeUrl = new URL('/auth/authorize', NOOS_URL);
  authorizeUrl.searchParams.set('client_id', 'openchat');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  if (state) {
    authorizeUrl.searchParams.set('state', state);
  }

  res.redirect(authorizeUrl.toString());
});

/**
 * GET /api/auth/google/url
 *
 * Returns the Google authorization URL the client should redirect the browser
 * to. The server builds it (rather than the client) so we control the scopes,
 * the redirect_uri whitelist, and the state CSRF check, without having to
 * expose the client_id more places than necessary. The client_id itself is
 * not a secret, but centralizing keeps configuration in one place.
 *
 * Query params (all optional):
 *   redirect_uri  — must match one of the URIs configured in the GCP OAuth
 *                   client. Defaults to <APP_BASE>/auth/google/callback where
 *                   APP_BASE is derived from the Host header.
 *   state         — opaque value the client passes through. Round-tripped via
 *                   Google. The frontend should also stash it in
 *                   sessionStorage and verify on callback. Defaults to a
 *                   server-generated nanoid.
 *   prompt        — pass-through to Google (e.g. "select_account").
 *
 * Returns: { url: string, state: string }
 */
router.get('/google/url', (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: 'Google sign-in not configured on this server' });
    return;
  }

  // Default redirect_uri = the frontend callback path on the same origin the
  // request came from. Honors X-Forwarded-Proto/Host when behind a proxy.
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host') || 'localhost';
  const defaultRedirect = `${proto}://${host}/auth/google/callback`;

  const requestedRedirect = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined;
  const redirectUri = requestedRedirect || defaultRedirect;

  const state = typeof req.query.state === 'string' && req.query.state.length > 0
    ? req.query.state
    : nanoid();

  const prompt = typeof req.query.prompt === 'string' ? req.query.prompt : undefined;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);
  if (prompt) {
    authUrl.searchParams.set('prompt', prompt);
  }

  res.json({ url: authUrl.toString(), state, redirectUri });
});

/**
 * POST /api/auth/google/exchange
 * Body: { code: string, redirectUri: string }
 *
 * Exchanges the authorization code for Google tokens, fetches the user's
 * profile, MERGEs the user by email in Neo4j (same shape as /dev-login), and
 * returns an OpenChat JWT.
 *
 * This is sign-up AND sign-in in one endpoint — MERGE handles both. If a user
 * with the same email already exists (e.g. they previously used /dev-login or
 * Noos SSO), we attach the Google identifiers to that record rather than
 * forking. Single identity per email.
 */
router.post('/google/exchange', async (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(503).json({ error: 'Google sign-in not configured on this server' });
    return;
  }

  const { code, redirectUri } = req.body ?? {};
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  if (!redirectUri || typeof redirectUri !== 'string') {
    res.status(400).json({ error: 'redirectUri is required' });
    return;
  }

  // 1. Exchange code for tokens.
  let tokenJson: GoogleTokenResponse;
  try {
    const tokenBody = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      console.error('Google token exchange failed:', tokenRes.status, errText.slice(0, 400));
      res.status(401).json({ error: 'Google token exchange failed' });
      return;
    }
    tokenJson = await tokenRes.json() as GoogleTokenResponse;
  } catch (e) {
    console.error('Google token exchange error:', e);
    res.status(502).json({ error: 'Could not reach Google to exchange code' });
    return;
  }

  // 2. Fetch userinfo with the access token.
  let userinfo: GoogleUserInfo;
  try {
    const uRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!uRes.ok) {
      const errText = await uRes.text().catch(() => '');
      console.error('Google userinfo failed:', uRes.status, errText.slice(0, 400));
      res.status(401).json({ error: 'Google userinfo lookup failed' });
      return;
    }
    userinfo = await uRes.json() as GoogleUserInfo;
  } catch (e) {
    console.error('Google userinfo error:', e);
    res.status(502).json({ error: 'Could not reach Google for userinfo' });
    return;
  }

  if (!userinfo.email) {
    res.status(400).json({ error: 'Google account did not provide an email' });
    return;
  }

  // 3. MERGE the user. Same shape as /dev-login plus googleSub/picture so we
  // can find the same record later even if email changes.
  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    const displayName = userinfo.name
      || [userinfo.given_name, userinfo.family_name].filter(Boolean).join(' ')
      || userinfo.email;

    const result = await session.run(`
      MERGE (u:User {email: $email})
      ON CREATE SET
        u.id = $id,
        u.name = $name,
        u.createdAt = datetime($now),
        u.presenceStatus = 'available',
        u.lastSeenAt = datetime($now),
        u.googleSub = $sub,
        u.googleEmailVerified = $emailVerified,
        u.avatarUrl = $picture,
        u.signupProvider = 'google'
      ON MATCH SET
        u.lastSeenAt = datetime($now),
        u.presenceStatus = 'available',
        u.googleSub = coalesce(u.googleSub, $sub),
        u.googleEmailVerified = coalesce(u.googleEmailVerified, $emailVerified),
        u.avatarUrl = coalesce(u.avatarUrl, $picture)
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .avatarUrl, .isBot } AS user
    `, {
      email: userinfo.email,
      name: displayName,
      id: nanoid(),
      now,
      sub: userinfo.sub,
      emailVerified: userinfo.email_verified ?? false,
      picture: userinfo.picture ?? null,
    });

    const user = toJS(result.records[0].get('user')) as {
      id: string; email: string; name: string;
    };

    const token = jwt.sign(
      { userId: user.id, email: user.email } as AuthUser,
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user,
      expiresIn: 7 * 24 * 60 * 60,
      provider: 'google',
    });
  } catch (e) {
    console.error('Google sign-in: failed to upsert user:', e);
    res.status(500).json({ error: 'Sign-in failed' });
  } finally {
    await session.close();
  }
});

export default router;
