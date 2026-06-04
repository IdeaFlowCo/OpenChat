/**
 * Web push + native (Expo) push helpers. Sends to all of a user's stored
 * subscriptions and registered native device tokens.
 *
 * - Web Push (VAPID): subscriptions stored on (User)-[:HAS_PUSH_SUBSCRIPTION]->(PushSubscription).
 *   Auto-deletes subscriptions that return 404 / 410 (browser revoked it).
 * - Native (iOS / Android via Expo Push): tokens stored on
 *   (User)-[:HAS_PUSH_TOKEN]->(NativePushToken {userId, platform, token}).
 *   Sent through Expo's REST endpoint at https://exp.host/--/api/v2/push/send.
 *   No env var needed; the endpoint is public. Tokens that come back with
 *   DeviceNotRegistered are deleted.
 *
 * OpenChat-3fw (web push). OpenChat-vg7 (native push).
 */

import webpush from 'web-push';
import { getDriver } from '../db.js';

const VAPID_PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:dev@globalbr.ai').trim();

const configured = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  // Don't crash on boot. Just skip-and-warn at send time.
  console.warn('[push] VAPID keys not configured — push notifications disabled.');
}

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export interface PushPayload {
  /** Used as the OS notification title. */
  title: string;
  /** OS notification body. Truncated to ~140 chars by the SW. */
  body: string;
  /** Data attached to the notification; SW uses it to focus the right conversation on click. */
  data?: {
    conversationId?: string;
    messageId?: string;
    type?: 'message' | 'mention' | 'group-add' | 'other';
    [key: string]: unknown;
  };
  /** Override the default icon. */
  icon?: string;
  /** Override the default badge icon. */
  badge?: string;
  /** A tag groups notifications — same tag replaces previous. */
  tag?: string;
}

/**
 * Send a native (Expo) push to every NativePushToken registered for the user.
 * Tokens that Expo reports as DeviceNotRegistered are deleted from Neo4j.
 *
 * The Expo push endpoint is public — no API key needed for v1. (For higher
 * volume, we'd want EXPO_ACCESS_TOKEN to lift the rate limit.)
 */
export async function sendNativePushToUser(
  userId: string,
  payload: PushPayload
): Promise<{ delivered: number; removed: number; failed: number }> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_PUSH_TOKEN]->(t:NativePushToken)
      RETURN t { .token, .platform } AS tok
      `,
      { userId }
    );
    const tokens = result.records
      .map((r) => r.get('tok') as { token?: string; platform?: string })
      .filter((t): t is { token: string; platform: string } => Boolean(t?.token));
    if (tokens.length === 0) return { delivered: 0, removed: 0, failed: 0 };

    const messages = tokens.map((t) => ({
      to: t.token,
      title: payload.title,
      body: payload.body.slice(0, 200),
      sound: 'default',
      data: payload.data || {},
    }));

    let delivered = 0;
    let removed = 0;
    let failed = 0;
    const gone: string[] = [];

    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        console.warn(`[push:native] HTTP ${res.status} from Expo push`);
        return { delivered: 0, removed: 0, failed: tokens.length };
      }

      const body = (await res.json()) as {
        data?: Array<{
          status?: 'ok' | 'error';
          message?: string;
          details?: { error?: string };
        }>;
      };
      const tickets = Array.isArray(body.data) ? body.data : [];
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'ok') {
          delivered++;
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          gone.push(tokens[i].token);
          removed++;
        } else {
          console.warn(`[push:native] send failed for token ${tokens[i].token.slice(0, 24)}…:`, ticket.message || ticket.details?.error);
          failed++;
        }
      });
    } catch (err) {
      console.warn('[push:native] fetch error:', err);
      return { delivered, removed, failed: tokens.length };
    }

    if (gone.length > 0) {
      await session.run(
        `
        UNWIND $tokens AS tok
        MATCH (t:NativePushToken {token: tok})
        DETACH DELETE t
        `,
        { tokens: gone }
      );
    }

    return { delivered, removed, failed };
  } finally {
    await session.close();
  }
}

/**
 * Send a push payload to every subscription the user has registered.
 * Subscriptions that return 404/410 (Gone) are deleted automatically.
 * Returns { delivered, removed } counts.
 *
 * Note: this fans out to BOTH web push (VAPID) AND native push (Expo) so a
 * single call covers all of a user's devices. Native push runs unconditionally
 * (no VAPID needed); web push only runs if VAPID is configured.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<{ delivered: number; removed: number; failed: number }> {
  // Always try native push (Expo doesn't require server config).
  const nativeResult = await sendNativePushToUser(userId, payload).catch((err) => {
    console.warn('[push] native push failed:', err);
    return { delivered: 0, removed: 0, failed: 0 };
  });

  if (!configured) return nativeResult;

  const session = getDriver().session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {id: $userId})-[:HAS_PUSH_SUBSCRIPTION]->(s:PushSubscription)
      RETURN s { .endpoint, .p256dh, .auth } AS sub
      `,
      { userId }
    );

    const subs: PushSubscriptionRecord[] = result.records.map((r) =>
      r.get('sub') as PushSubscriptionRecord
    );
    if (subs.length === 0) return nativeResult;

    const json = JSON.stringify({
      title: payload.title,
      body: payload.body.slice(0, 200),
      icon: payload.icon || '/icons/icon-192.png',
      badge: payload.badge || '/icons/icon-192.png',
      tag: payload.tag,
      data: payload.data,
    });

    let delivered = 0;
    let removed = 0;
    let failed = 0;
    const gone: string[] = [];

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            json
          );
          delivered++;
        } catch (err) {
          const e = err as { statusCode?: number; body?: string };
          if (e.statusCode === 404 || e.statusCode === 410) {
            gone.push(sub.endpoint);
            removed++;
          } else {
            console.warn(`[push] send failed for ${sub.endpoint.slice(0, 60)}…:`, e.statusCode, e.body);
            failed++;
          }
        }
      })
    );

    // Cleanup gone subscriptions in one round-trip
    if (gone.length > 0) {
      await session.run(
        `
        UNWIND $endpoints AS ep
        MATCH (s:PushSubscription {endpoint: ep})
        DETACH DELETE s
        `,
        { endpoints: gone }
      );
    }

    return {
      delivered: delivered + nativeResult.delivered,
      removed: removed + nativeResult.removed,
      failed: failed + nativeResult.failed,
    };
  } finally {
    await session.close();
  }
}

/**
 * Fan-out helper: send the same payload to a list of users.
 * Returns aggregate counts.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<{ delivered: number; removed: number; failed: number }> {
  const results = await Promise.all(userIds.map((uid) => sendPushToUser(uid, payload)));
  return results.reduce(
    (acc, r) => ({
      delivered: acc.delivered + r.delivered,
      removed: acc.removed + r.removed,
      failed: acc.failed + r.failed,
    }),
    { delivered: 0, removed: 0, failed: 0 }
  );
}
