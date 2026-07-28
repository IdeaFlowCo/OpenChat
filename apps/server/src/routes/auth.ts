import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getDriver } from '../db.js';
import { requireAuth, AuthUser } from '../middleware/auth.js';

const router = Router();
function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-secret-change-me';
}
const NOOS_URL = process.env.NOOS_URL || 'http://localhost:52743';

const EXPORT_RANGES = {
  last_hour: { label: 'Last hour', ms: 60 * 60 * 1000 },
  last_day: { label: 'Last day', ms: 24 * 60 * 60 * 1000 },
  last_week: { label: 'Last week', ms: 7 * 24 * 60 * 60 * 1000 },
  last_month: { label: 'Last month', ms: 30 * 24 * 60 * 60 * 1000 },
  all_time: { label: 'All time', ms: null },
} as const;

type ExportRange = keyof typeof EXPORT_RANGES;

function parseExportRange(raw: unknown): ExportRange | null {
  const value = typeof raw === 'string' ? raw : 'last_day';
  return value in EXPORT_RANGES ? value as ExportRange : null;
}

function exportSince(range: ExportRange): string | null {
  const ms = EXPORT_RANGES[range].ms;
  if (ms === null) return null;
  return new Date(Date.now() - ms).toISOString();
}

function sendJsonDownload(res: Response, filename: string, payload: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(payload);
}

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
 * GET /api/auth/export?range=last_day
 *
 * Download an account-scoped JSON bundle: profile, conversations the caller is
 * still a participant in, matching messages for the selected range, thoughts,
 * blocked users, and non-secret agent key metadata if present.
 */
router.get('/export', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const range = parseExportRange(req.query.range);

  if (!range) {
    res.status(400).json({ error: `range must be one of: ${Object.keys(EXPORT_RANGES).join(', ')}` });
    return;
  }

  const since = exportSince(range);

  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})
      CALL {
        WITH u
        OPTIONAL MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation)
        WITH collect(c { .id, .title, .type, .createdAt, .updatedAt, .lastMessageAt, .lastMessagePreview }) AS conversations
        RETURN conversations
      }
      CALL {
        WITH u
        OPTIONAL MATCH (u)-[:PARTICIPATES_IN]->(c:Conversation)<-[:IN_CONVERSATION]-(m:Message)
        WHERE $since IS NULL OR m.createdAt >= datetime($since)
        OPTIONAL MATCH (sender:User {id: m.senderId})
        WITH m, sender
        ORDER BY m.createdAt ASC
        RETURN collect(m {
          .*,
          sender: sender { .id, .name, .email, .isBot }
        }) AS messages
      }
      CALL {
        WITH u
        OPTIONAL MATCH (u)-[:HAS_THOUGHT]->(t:Thought)
        WHERE $since IS NULL OR t.createdAt >= datetime($since)
        WITH t ORDER BY t.createdAt ASC
        RETURN collect(t { .id, .text, .kind, .status, .createdAt, .updatedAt }) AS thoughts
      }
      CALL {
        WITH u
        OPTIONAL MATCH (u)-[:BLOCKED]->(blocked:User)
        RETURN collect(blocked { .id, .name, .email }) AS blockedUsers
      }
      CALL {
        WITH u
        OPTIONAL MATCH (u)-[:OWNS_KEY]->(ak)
        RETURN collect(ak {
          .id,
          .name,
          .keyPrefix,
          .scopes,
          .agentName,
          .agentVersion,
          .createdAt,
          .lastUsedAt,
          .expiresAt,
          .revokedAt
        }) AS agentKeys
      }
      RETURN u {
        .id,
        .email,
        .name,
        .presenceStatus,
        .statusMessage,
        .avatarUrl,
        .createdAt,
        .updatedAt,
        .onboardedAt
      } AS user,
      conversations,
      messages,
      thoughts,
      blockedUsers,
      agentKeys
    `, { userId, since });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const record = result.records[0];
    const messages = (toJS(record.get('messages')) as Record<string, unknown>[])
      .filter((m) => m && Object.keys(m).length > 0)
      .map((msg) => {
        if (typeof msg.attachments === 'string') {
          try { msg.attachments = JSON.parse(msg.attachments); } catch { /* leave raw */ }
        }
        return msg;
      });

    const exportedAt = new Date().toISOString();
    sendJsonDownload(res, `openchat-account-${range}.json`, {
      schema: 'openchat.account_export.v1',
      exportedAt,
      range: { key: range, label: EXPORT_RANGES[range].label, since },
      user: toJS(record.get('user')),
      conversations: (toJS(record.get('conversations')) as unknown[]).filter(Boolean),
      messageCount: messages.length,
      messages,
      thoughts: (toJS(record.get('thoughts')) as unknown[]).filter(Boolean),
      blockedUsers: (toJS(record.get('blockedUsers')) as unknown[]).filter(Boolean),
      agentKeys: (toJS(record.get('agentKeys')) as unknown[]).filter(Boolean),
    });
  } catch (error) {
    console.error('Error exporting account:', error);
    res.status(500).json({ error: 'Failed to export account data' });
  } finally {
    await session.close();
  }
});

/**
 * PATCH /api/auth/me — Update current user's profile (OpenChat-tml + OpenChat-x2s)
 * Body: { name?: string, statusMessage?: string, avatarUrl?: string, onboardingComplete?: boolean }
 *
 * Persists name, statusMessage, avatarUrl, and/or marks onboarding complete
 * (sets `onboardedAt` to now on first call with onboardingComplete=true).
 * Emits `user:profile-updated` via Socket.IO to all users who share a
 * conversation with the editor so their UIs can refresh participant info
 * without polling.
 */
router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { name, statusMessage, avatarUrl, onboardingComplete } = (req.body ?? {}) as {
    name?: string;
    statusMessage?: string;
    avatarUrl?: string;
    onboardingComplete?: boolean;
  };

  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }

  if (avatarUrl !== undefined && typeof avatarUrl !== 'string') {
    res.status(400).json({ error: 'avatarUrl must be a string' });
    return;
  }

  try {
    const now = new Date().toISOString();
    const result = await session.run(`
      MATCH (u:User {id: $userId})
      SET u.name = CASE WHEN $name IS NOT NULL THEN $name ELSE u.name END,
          u.statusMessage = CASE WHEN $statusMessage IS NOT NULL THEN $statusMessage ELSE u.statusMessage END,
          u.avatarUrl = CASE WHEN $avatarUrl IS NOT NULL THEN $avatarUrl ELSE u.avatarUrl END,
          u.onboardedAt = CASE WHEN $onboardingComplete = true AND u.onboardedAt IS NULL THEN datetime($now) ELSE u.onboardedAt END,
          u.updatedAt = datetime($now)
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .avatarUrl, .isBot, .onboardedAt } AS user
    `, {
      userId,
      name: name?.trim() ?? null,
      statusMessage: statusMessage ?? null,
      avatarUrl: avatarUrl ?? null,
      onboardingComplete: onboardingComplete === true,
      now,
    });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = toJS(result.records[0].get('user')) as Record<string, unknown>;

    // Broadcast to anyone who shares a conversation with this user so their
    // participant lists and DM headers update in real time.
    const io = req.app.get('io') as unknown as import('socket.io').Server | undefined;
    if (io) {
      // Find all conversation-room members who share a conversation.
      const convResult = await session.run(`
        MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
        RETURN DISTINCT c.id AS conversationId
      `, { userId });

      for (const r of convResult.records) {
        const convId = r.get('conversationId') as string;
        io.to(`conversation:${convId}`).emit('user:profile-updated', {
          userId,
          name: user.name,
          statusMessage: user.statusMessage,
        });
      }
    }

    res.json(user);
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
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
  // request came from. We honor (in order): the standard X-Forwarded-Proto,
  // and Cloudflare's `cf-visitor` header (JSON `{"scheme":"https"}`) which
  // Cloudflare adds on requests to origins. Without the CF-specific fallback
  // we end up building `http://chat.globalbr.ai/...` because CF strips
  // X-Forwarded-Proto from requests to the origin. Pure curl tests would
  // still be off without one of these, but the React client always passes
  // an explicit redirect_uri so this is hygiene, not a real flow blocker.
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const cfVisitor = req.headers['cf-visitor'] as string | undefined;
  let cfScheme: string | undefined;
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: string };
      if (parsed.scheme === 'http' || parsed.scheme === 'https') cfScheme = parsed.scheme;
    } catch {
      // Not JSON or unexpected shape — ignore, fall through to other sources.
    }
  }
  const proto = forwardedProto || cfScheme || req.protocol;
  const host = forwardedHost || req.get('host') || 'localhost';
  const defaultRedirect = `${proto}://${host}/auth/google/callback`;

  const requestedRedirect = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined;
  const redirectUri = requestedRedirect || defaultRedirect;

  const state = typeof req.query.state === 'string' && req.query.state.length > 0
    ? req.query.state
    : nanoid();

  // Default to the account chooser so users can pick/switch Google accounts
  // (without it, Google silently reuses the single signed-in session). Callers
  // can override via ?prompt= (e.g. 'consent', 'none').
  const prompt = typeof req.query.prompt === 'string' ? req.query.prompt : 'select_account';

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', prompt);

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

/**
 * POST /api/auth/google/idtoken-exchange
 * Body: { idToken: string }
 *
 * Native mobile path for "Sign in with Google" — used by the iOS app (and any
 * future Android client). On iOS the OAuth client is type=iOS (no client
 * secret; PKCE). The mobile app uses expo-auth-session to talk to Google
 * directly and receives an ID token. The mobile then POSTs that ID token
 * here for verification + session creation.
 *
 * Why a separate endpoint from /google/exchange: that one swaps an auth CODE
 * using the Web client's secret. iOS clients have no secret. The two flows
 * land at the same user record (MERGE by email) so a person who signed up on
 * the web and then signs in on iOS gets the same identity.
 *
 * Accepted audiences (`aud` claim on the ID token):
 *   - GOOGLE_CLIENT_ID         (Web client; used if anything else does an
 *                              ID-token flow in the future)
 *   - GOOGLE_IOS_CLIENT_ID     (iOS client created for this app)
 */
router.post('/google/idtoken-exchange', async (req: Request, res: Response) => {
  const webClientId = process.env.GOOGLE_CLIENT_ID;
  const iosClientId = process.env.GOOGLE_IOS_CLIENT_ID;
  if (!webClientId && !iosClientId) {
    res.status(503).json({ error: 'Google sign-in not configured on this server' });
    return;
  }

  const { idToken } = (req.body ?? {}) as { idToken?: string };
  if (!idToken || typeof idToken !== 'string') {
    res.status(400).json({ error: 'idToken is required' });
    return;
  }

  const acceptedAudiences = [iosClientId, webClientId].filter(Boolean) as string[];

  // 1. Verify the ID token against Google's certs. OAuth2Client.verifyIdToken
  // checks: signature against current Google JWKS, issuer (accounts.google.com),
  // expiry, and that `aud` matches one of our accepted audiences.
  const client = new OAuth2Client();
  let payload: TokenPayload | undefined;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: acceptedAudiences,
    });
    payload = ticket.getPayload();
  } catch (e) {
    console.error('Google ID token verify failed:', e instanceof Error ? e.message : e);
    res.status(401).json({ error: 'Invalid Google ID token' });
    return;
  }

  if (!payload || !payload.email) {
    res.status(400).json({ error: 'Google ID token did not include an email' });
    return;
  }

  // 2. MERGE the user — same Cypher as /google/exchange.
  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    const displayName = payload.name
      || [payload.given_name, payload.family_name].filter(Boolean).join(' ')
      || payload.email;

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
        u.signupProvider = 'google-ios'
      ON MATCH SET
        u.lastSeenAt = datetime($now),
        u.presenceStatus = 'available',
        u.googleSub = coalesce(u.googleSub, $sub),
        u.googleEmailVerified = coalesce(u.googleEmailVerified, $emailVerified),
        u.avatarUrl = coalesce(u.avatarUrl, $picture)
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .avatarUrl, .isBot } AS user
    `, {
      email: payload.email,
      name: displayName,
      id: nanoid(),
      now,
      sub: payload.sub,
      emailVerified: payload.email_verified ?? false,
      picture: payload.picture ?? null,
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
      provider: 'google-ios',
    });
  } catch (e) {
    console.error('Google iOS sign-in: failed to upsert user:', e);
    res.status(500).json({ error: 'Sign-in failed' });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/auth/me — Account deletion (OpenChat-nhy)
 *
 * Atomically:
 *   1. Redact all of this user's messages (content → 'Message deleted', etc.)
 *   2. Delete NativePushToken nodes
 *   3. Delete the User node (which cascades :PARTICIPATES_IN, :BLOCKED, etc.)
 *
 * Returns 204 on success. Emits `user:deleted` via Socket.IO so other clients
 * can refresh their views.
 */
router.delete('/me', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const now = new Date().toISOString();

    // Run everything in a single write transaction for atomicity.
    await session.executeWrite(async (tx) => {
      // 1. Redact messages authored by this user.
      await tx.run(`
        MATCH (m:Message {senderId: $userId})
        SET m.content    = 'Message deleted',
            m.senderName = 'Former user',
            m.editedAt   = datetime($now),
            m.replyToId  = null
      `, { userId, now });

      // 2. Delete NativePushToken nodes belonging to this user.
      await tx.run(`
        MATCH (t:NativePushToken {userId: $userId})
        DETACH DELETE t
      `, { userId });

      // 2b. Delete Thought nodes owned by this user (OpenChat-zi1).
      await tx.run(`
        MATCH (u:User {id: $userId})-[:HAS_THOUGHT]->(th:Thought)
        DETACH DELETE th
      `, { userId });

      // 3. Delete the User node (and all its relationships).
      await tx.run(`
        MATCH (u:User {id: $userId})
        DETACH DELETE u
      `, { userId });
    });

    // Emit so other connected clients refresh conversations / participant lists.
    const io = req.app.get('io');
    if (io) {
      io.emit('user:deleted', { userId });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Account deletion failed' });
  } finally {
    await session.close();
  }
});

// Apple JWKS — cached per process, refreshes automatically via jose.
const APPLE_JWKS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys')
);
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * POST /api/auth/apple/idtoken-exchange — Sign in with Apple (OpenChat-c08)
 * Body: { identityToken: string, fullName?: { givenName, familyName }, email? }
 *
 * Verifies the Apple-issued JWT, MERGEs the User by email (or appleSub when
 * email is a private relay address), and returns the same token+user shape as
 * the Google exchange endpoints.
 */
router.post('/apple/idtoken-exchange', async (req: Request, res: Response) => {
  const bundleId = process.env.APPLE_BUNDLE_ID || 'com.jacobcole.openchat';

  const {
    identityToken,
    fullName,
    email: bodyEmail,
  } = (req.body ?? {}) as {
    identityToken?: string;
    fullName?: { givenName?: string; familyName?: string };
    email?: string;
  };

  if (!identityToken || typeof identityToken !== 'string') {
    res.status(400).json({ error: 'identityToken is required' });
    return;
  }

  // 1. Verify the identity token via Apple's JWKS.
  let payload: Record<string, unknown>;
  try {
    const { payload: p } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: APPLE_ISSUER,
      audience: bundleId,
    });
    payload = p as Record<string, unknown>;
  } catch (e) {
    console.error('Apple ID token verify failed:', e instanceof Error ? e.message : e);
    res.status(401).json({ error: 'Invalid Apple identity token' });
    return;
  }

  const appleSub = payload.sub as string | undefined;
  if (!appleSub) {
    res.status(400).json({ error: 'Apple token missing sub claim' });
    return;
  }

  // email claim may be absent (Hide My Email) or a private relay address.
  const tokenEmail = payload.email as string | undefined;
  const email = tokenEmail || bodyEmail || null;
  const isPrivateRelay = email?.endsWith('@privaterelay.appleid.com') ?? false;

  // Derive a display name from the one-time fullName payload Apple sends on
  // first sign-in. On subsequent sign-ins fullName is empty — we preserve
  // whatever was stored on first sign-in via ON MATCH coalesce.
  const displayName =
    [fullName?.givenName, fullName?.familyName].filter(Boolean).join(' ').trim() ||
    (email && !isPrivateRelay ? email : null) ||
    'Apple User';

  const dbSession = getDriver().session();
  try {
    const now = new Date().toISOString();

    // MERGE strategy:
    //   - If we have a real email → merge by email (links to existing account)
    //   - If email is hidden → merge by appleSub (no cross-provider linking possible)
    const mergeQuery = email && !isPrivateRelay
      ? `
        MERGE (u:User {email: $email})
        ON CREATE SET
          u.id = $id,
          u.name = $name,
          u.createdAt = datetime($now),
          u.presenceStatus = 'available',
          u.lastSeenAt = datetime($now),
          u.appleSub = $appleSub,
          u.signupProvider = 'apple'
        ON MATCH SET
          u.lastSeenAt = datetime($now),
          u.presenceStatus = 'available',
          u.appleSub = coalesce(u.appleSub, $appleSub),
          u.name = CASE WHEN u.name IS NULL OR u.name = '' THEN $name ELSE u.name END
        RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .avatarUrl, .isBot } AS user
      `
      : `
        MERGE (u:User {appleSub: $appleSub})
        ON CREATE SET
          u.id = $id,
          u.name = $name,
          u.email = $email,
          u.createdAt = datetime($now),
          u.presenceStatus = 'available',
          u.lastSeenAt = datetime($now),
          u.signupProvider = 'apple'
        ON MATCH SET
          u.lastSeenAt = datetime($now),
          u.presenceStatus = 'available',
          u.email = coalesce(u.email, $email),
          u.name = CASE WHEN u.name IS NULL OR u.name = '' THEN $name ELSE u.name END
        RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .avatarUrl, .isBot } AS user
      `;

    const result = await dbSession.run(mergeQuery, {
      email: email ?? null,
      appleSub,
      name: displayName,
      id: nanoid(),
      now,
    });

    if (result.records.length === 0) {
      res.status(500).json({ error: 'Failed to create or find user' });
      return;
    }

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
      provider: 'apple',
    });
  } catch (e) {
    console.error('Apple sign-in: failed to upsert user:', e);
    res.status(500).json({ error: 'Sign-in failed' });
  } finally {
    await dbSession.close();
  }
});

export default router;
