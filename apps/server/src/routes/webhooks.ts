/**
 * Outbound webhook subscriptions (openchat bot-channel).
 *
 * Lets an agent-key user (e.g. the groupbrain bot) register a URL that OpenChat
 * POSTs to whenever a message lands in a conversation they participate in — the
 * push equivalent of polling GET /api/chat/messages/since. See
 * services/webhookDispatch.ts for the delivery + signing logic.
 *
 * Endpoints (all authenticated via resolveActor, so a Bearer oc_<key> works):
 *   POST   /api/webhooks       — create a subscription (returns the secret once)
 *   GET    /api/webhooks       — list the caller's subscriptions
 *   DELETE /api/webhooks/:id   — delete a subscription
 *
 * Ownership mirrors agent keys: (:User)-[:OWNS_WEBHOOK]->(:Webhook), and a
 * webhook only ever receives events for conversations its owner is in.
 */

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { MESSAGE_CREATED_EVENT } from '../services/webhookDispatch.js';

const router = Router();

const SUPPORTED_EVENTS = new Set([MESSAGE_CREATED_EVENT]);
const MAX_SECRET_LENGTH = 256;
const SAFE_SECRET_RE = /^[A-Za-z0-9._~+=/@:-]+$/;

function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSuppliedSecret(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return '';

  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SECRET_LENGTH || !SAFE_SECRET_RE.test(normalized)) return '';
  return normalized;
}

// ── POST /api/webhooks ────────────────────────────────────────────────────────

router.post('/', resolveActor, async (req: Request, res: Response) => {
  const ownerUserId = req.user!.userId;
  const { url, events, conversationId, secret } = req.body as {
    url?: string;
    events?: string[];
    conversationId?: string | null;
    secret?: string;
  };

  if (!isValidHttpUrl(url)) {
    res.status(400).json({ error: 'url must be a valid http(s) URL' });
    return;
  }

  // Default to the only event we currently emit; validate any explicit set.
  let resolvedEvents: string[] = [MESSAGE_CREATED_EVENT];
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string')) {
      res.status(400).json({ error: 'events must be a non-empty array of strings' });
      return;
    }
    const unknown = events.filter((e) => !SUPPORTED_EVENTS.has(e));
    if (unknown.length > 0) {
      res.status(400).json({ error: `unsupported events: ${unknown.join(', ')}` });
      return;
    }
    resolvedEvents = Array.from(new Set(events));
  }

  if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') {
    res.status(400).json({ error: 'conversationId must be a string or null' });
    return;
  }

  // Caller may supply their own shared secret; otherwise we mint one.
  const suppliedSecret = normalizeSuppliedSecret(secret);
  if (suppliedSecret === '') {
    res.status(400).json({ error: 'secret must use 1-256 URL/header-safe ASCII characters' });
    return;
  }

  const resolvedSecret = suppliedSecret ?? `whsec_${crypto.randomBytes(24).toString('base64url')}`;

  const id = nanoid();
  const createdAt = new Date().toISOString();
  const createdByKeyId = req.agentKeyId ?? null;

  const session = getDriver().session();
  try {
    await session.run(
      `MATCH (u:User {id: $ownerUserId})
       CREATE (w:Webhook {
         id: $id,
         ownerUserId: $ownerUserId,
         url: $url,
         secret: $secret,
         events: $events,
         conversationId: $conversationId,
         createdByKeyId: $createdByKeyId,
         createdAt: $createdAt
       })
       CREATE (u)-[:OWNS_WEBHOOK]->(w)`,
      {
        id,
        ownerUserId,
        url,
        secret: resolvedSecret,
        events: resolvedEvents,
        conversationId: conversationId ?? null,
        createdByKeyId,
        createdAt,
      }
    );
  } finally {
    await session.close();
  }

  // Return the secret ONCE, on create, like a minted key.
  res.status(201).json({
    id,
    url,
    events: resolvedEvents,
    conversationId: conversationId ?? null,
    secret: resolvedSecret,
    createdAt,
  });
});

// ── GET /api/webhooks ─────────────────────────────────────────────────────────

router.get('/', resolveActor, async (req: Request, res: Response) => {
  const ownerUserId = req.user!.userId;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $ownerUserId})-[:OWNS_WEBHOOK]->(w:Webhook)
       RETURN w { .id, .url, .events, .conversationId, .createdAt } AS webhook
       ORDER BY w.createdAt DESC`,
      { ownerUserId }
    );
    // Note: secret is intentionally NOT returned in the list (only on create).
    res.json(result.records.map((r) => r.get('webhook')));
  } finally {
    await session.close();
  }
});

// ── DELETE /api/webhooks/:id ──────────────────────────────────────────────────

router.delete('/:id', resolveActor, async (req: Request, res: Response) => {
  const ownerUserId = req.user!.userId;
  const { id } = req.params;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $ownerUserId})-[:OWNS_WEBHOOK]->(w:Webhook {id: $id})
       WITH w, w.id AS deletedId
       DETACH DELETE w
       RETURN deletedId`,
      { ownerUserId, id }
    );
    if (result.records.length === 0) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ ok: true });
  } finally {
    await session.close();
  }
});

export default router;
