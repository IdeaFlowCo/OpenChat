import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { requireAuth, AuthUser } from '../middleware/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const NOOS_URL = process.env.NOOS_URL || 'http://localhost:4000';

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
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage } AS user
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
      JWT_SECRET,
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
      RETURN u { .id, .email, .name, .presenceStatus, .statusMessage, .lastSeenAt } AS user
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
  const redirectUri = req.query.redirect_uri || 'http://localhost:5173/auth/callback';

  // In production, redirect to Noos OAuth
  // For now, return info about dev login
  res.json({
    message: 'In production, this redirects to Noos login',
    devLogin: 'POST /api/auth/dev-login with { email, name? }',
    noosUrl: NOOS_URL,
    redirectUri
  });
});

export default router;
