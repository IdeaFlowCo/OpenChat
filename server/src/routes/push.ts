/**
 * Web Push subscription management.
 *
 * Endpoints:
 *   GET    /api/push/vapid-public-key     — public key for client subscribe
 *   POST   /api/push/subscribe            — register a browser/device subscription
 *   DELETE /api/push/subscribe            — unregister by endpoint
 *   GET    /api/push/subscriptions        — list caller's own subs (debug)
 *
 * Schema: (User)-[:HAS_PUSH_SUBSCRIPTION]->(:PushSubscription { endpoint, p256dh, auth, userAgent, createdAt, lastUsedAt })
 * endpoint is the unique key (one subscription per device/browser).
 *
 * OpenChat-3fw.
 */

import { Router, Request, Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getVapidPublicKey, isPushConfigured } from '../services/push.js';

const router = Router();

// Public — no auth needed. Client fetches once at subscribe time.
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: 'Push notifications not configured on this server.' });
    return;
  }
  res.json({ publicKey: getVapidPublicKey() });
});

// Subscribe — store the PushSubscriptionJSON the browser produces.
// Body: { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }
router.post('/subscribe', requireAuth, async (req: Request, res: Response) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: 'Push notifications not configured on this server.' });
    return;
  }
  const userId = req.user!.userId;
  const { subscription, userAgent } = req.body as {
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    userAgent?: string;
  };

  const endpoint = subscription?.endpoint?.trim();
  const p256dh = subscription?.keys?.p256dh?.trim();
  const auth = subscription?.keys?.auth?.trim();

  if (!endpoint || !p256dh || !auth) {
    res.status(400).json({ error: 'subscription.endpoint, keys.p256dh, keys.auth required' });
    return;
  }

  const session = getDriver().session();
  try {
    const now = new Date().toISOString();
    await session.run(
      `
      MATCH (u:User {id: $userId})
      MERGE (s:PushSubscription {endpoint: $endpoint})
        ON CREATE SET s.createdAt = datetime($now)
      SET s.p256dh = $p256dh,
          s.auth = $auth,
          s.userAgent = $userAgent,
          s.lastUsedAt = datetime($now)
      MERGE (u)-[:HAS_PUSH_SUBSCRIPTION]->(s)
      `,
      {
        userId,
        endpoint,
        p256dh,
        auth,
        userAgent: (userAgent || '').slice(0, 200),
        now,
      }
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error('[push] subscribe error:', error);
    res.status(500).json({ error: 'Failed to register push subscription' });
  } finally {
    await session.close();
  }
});

// Unsubscribe — delete by endpoint (caller-owned only).
// Body: { endpoint }
router.delete('/subscribe', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint?.trim()) {
    res.status(400).json({ error: 'endpoint required' });
    return;
  }

  const session = getDriver().session();
  try {
    await session.run(
      `
      MATCH (u:User {id: $userId})-[r:HAS_PUSH_SUBSCRIPTION]->(s:PushSubscription {endpoint: $endpoint})
      DETACH DELETE s
      `,
      { userId, endpoint: endpoint.trim() }
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('[push] unsubscribe error:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  } finally {
    await session.close();
  }
});

// Debug — list caller's own subscriptions.
router.get('/subscriptions', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_PUSH_SUBSCRIPTION]->(s:PushSubscription)
      RETURN s { .endpoint, .userAgent, .createdAt, .lastUsedAt } AS sub
      ORDER BY s.lastUsedAt DESC
      `,
      { userId }
    );
    const subs = result.records.map((r) => r.get('sub'));
    res.json({ subscriptions: subs });
  } catch (error) {
    console.error('[push] list error:', error);
    res.status(500).json({ error: 'Failed to list push subscriptions' });
  } finally {
    await session.close();
  }
});

export default router;
