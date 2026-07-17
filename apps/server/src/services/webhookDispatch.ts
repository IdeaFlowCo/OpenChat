/**
 * Outbound webhook dispatch (openchat bot-channel).
 *
 * Lets an external service (groupbrain is the first consumer) receive a live
 * push whenever a message lands in a conversation it participates in, instead
 * of polling GET /api/chat/messages/since. Subscriptions are (:Webhook) nodes
 * owned by an agent-key user (see routes/webhooks.ts).
 *
 * Design constraints (mirrors how link-preview / push / assistant are fired):
 *   - FIRE-AND-FORGET: dispatch never blocks or throws into the send path.
 *   - NO-OP when there is no matching subscription (the common case).
 *   - Each delivery has a short timeout and retries ONCE on failure.
 *
 * The payload is a normalized message shape and is signed two ways so the
 * receiver can verify it however it likes:
 *   - `X-OpenChat-Secret`    — the raw shared secret (groupbrain's
 *     isValidWebhookSecret accepts x-*-secret headers verbatim).
 *   - `X-OpenChat-Signature` — `sha256=<hex>` HMAC of the exact JSON body,
 *     keyed by the secret, for stronger tamper-evident verification.
 */

import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { getDriver } from '../db.js';

export const MESSAGE_CREATED_EVENT = 'message.created';

const DELIVERY_TIMEOUT_MS = 5_000;
const ALLOW_LOCAL_WEBHOOKS = ['1', 'true', 'yes'].includes(
  (process.env.WEBHOOK_ALLOW_LOCAL ?? '').toLowerCase()
);

export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  events: string[];
  conversationId: string | null;
}

export interface NormalizedMessagePayload {
  event: string;
  message: {
    id: string;
    conversationId: string;
    senderId: string | null;
    senderName: string | null;
    content: string;
    messageType: string;
    attachments: unknown;
    replyToId: string | null;
    createdAt: string | null;
  };
}

interface ResolvedWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Build the normalized outbound payload from a persisted message object (the
 * same shape the send paths broadcast over the socket).
 */
export function buildMessagePayload(
  event: string,
  message: Record<string, unknown>
): NormalizedMessagePayload {
  const sender = (message.sender as Record<string, unknown> | undefined) ?? undefined;
  return {
    event,
    message: {
      id: String(message.id ?? ''),
      conversationId: String(message.conversationId ?? ''),
      senderId: (message.senderId as string | undefined) ?? (sender?.id as string | undefined) ?? null,
      senderName: (sender?.name as string | undefined) ?? null,
      content: typeof message.content === 'string' ? message.content : '',
      messageType: typeof message.messageType === 'string' ? message.messageType : 'text',
      attachments: message.attachments ?? null,
      replyToId: (message.replyToId as string | undefined) ?? null,
      createdAt: (message.createdAt as string | undefined) ?? null,
    },
  };
}

/**
 * Build the headers for a single delivery: content type, the raw shared secret,
 * and an HMAC-SHA256 signature of the exact body string.
 */
export function buildWebhookHeaders(body: string, secret: string): Record<string, string> {
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-OpenChat-Secret': secret,
    'X-OpenChat-Signature': `sha256=${signature}`,
  };
}

/**
 * Pure filter: given every webhook owned by the conversation's participants,
 * pick the ones subscribed to `event` that either target this conversation or
 * have no conversation filter (all conversations). Returns [] when none match —
 * the caller then dispatches nothing.
 */
export function selectWebhooksForEvent(
  webhooks: WebhookSubscription[],
  event: string,
  conversationId: string
): WebhookSubscription[] {
  return webhooks.filter((w) => {
    const subscribed = Array.isArray(w.events) && w.events.includes(event);
    if (!subscribed) return false;
    return w.conversationId == null || w.conversationId === conversationId;
  });
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isLoopbackIPv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  return parts.length === 4 && parts[0] === 127;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  const ipv4Mapped = normalized.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) return isPrivateIPv4(ipv4Mapped[1]);

  const firstGroup = normalized.split(':')[0];
  const first = Number.parseInt(firstGroup || '0', 16);
  if (!Number.isInteger(first)) return true;

  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function isLoopbackIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  const ipv4Mapped = normalized.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  return ipv4Mapped ? isLoopbackIPv4(ipv4Mapped[1]) : false;
}

function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

function isLoopbackAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isLoopbackIPv4(address);
  if (family === 6) return isLoopbackIPv6(address);
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolveWebhookTarget(url: string): Promise<ResolvedWebhookTarget | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const hostname = normalizeHostname(parsed.hostname.toLowerCase());

  if (net.isIP(hostname)) {
    if (ALLOW_LOCAL_WEBHOOKS && isLoopbackAddress(hostname)) {
      return { url: parsed, address: hostname, family: net.isIP(hostname) as 4 | 6 };
    }
    if (isBlockedAddress(hostname)) return null;
    return { url: parsed, address: hostname, family: net.isIP(hostname) as 4 | 6 };
  }

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const validAddresses = addresses.filter((entry) => entry.family === 4 || entry.family === 6);
    if (!validAddresses.length) return null;

    const allLoopback = validAddresses.every((entry) => isLoopbackAddress(entry.address));
    if (ALLOW_LOCAL_WEBHOOKS && allLoopback) {
      const first = validAddresses[0];
      return { url: parsed, address: first.address, family: first.family as 4 | 6 };
    }

    if (validAddresses.some((entry) => isBlockedAddress(entry.address))) return null;

    const first = validAddresses[0];
    return { url: parsed, address: first.address, family: first.family as 4 | 6 };
  } catch {
    return null;
  }
}

export async function isSafeWebhookUrl(url: string): Promise<boolean> {
  return (await resolveWebhookTarget(url)) !== null;
}

function postPinnedWebhook(
  target: ResolvedWebhookTarget,
  headers: Record<string, string>,
  body: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const client = target.url.protocol === 'https:' ? https : http;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const req = client.request(
      target.url,
      {
        method: 'POST',
        headers,
        signal: controller.signal,
        lookup: (_hostname, _options, callback) => {
          if (!ALLOW_LOCAL_WEBHOOKS && isBlockedAddress(target.address)) {
            callback(new Error('Blocked webhook target address'), target.address, target.family);
            return;
          }
          if (ALLOW_LOCAL_WEBHOOKS && !isLoopbackAddress(target.address) && isBlockedAddress(target.address)) {
            callback(new Error('Blocked webhook target address'), target.address, target.family);
            return;
          }
          callback(null, target.address, target.family);
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          clearTimeout(timer);
          resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
        });
      }
    );

    req.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

/** POST a signed payload to one webhook, with a timeout and a single retry. */
async function deliver(webhook: WebhookSubscription, body: string): Promise<void> {
  const headers = buildWebhookHeaders(body, webhook.secret);

  const attempt = async (): Promise<boolean | 'blocked'> => {
    const target = await resolveWebhookTarget(webhook.url);
    if (!target) {
      console.warn(`[webhook] blocked unsafe delivery target: ${webhook.id} -> ${webhook.url}`);
      return 'blocked';
    }

    return postPinnedWebhook(target, headers, body);
  };

  const ok = await attempt();
  if (ok === 'blocked') return;
  if (ok === false) {
    // Retry exactly once.
    const retried = await attempt();
    if (retried === false) {
      console.warn(`[webhook] delivery failed after retry: ${webhook.id} -> ${webhook.url}`);
    }
  }
}

export async function ensureWebhookIndex(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(
      `CREATE INDEX webhook_owner_user_id IF NOT EXISTS
       FOR (w:Webhook) ON (w.ownerUserId)`
    );
  } finally {
    await session.close();
  }
}

/**
 * Load the webhook subscriptions that should receive a message event for this
 * conversation: webhooks owned by a participant, subscribed to the event, and
 * either unfiltered or targeting this conversation.
 */
async function loadMatchingWebhooks(
  event: string,
  conversationId: string,
  participantIds: string[]
): Promise<WebhookSubscription[]> {
  if (!participantIds.length) return [];
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (w:Webhook)
       WHERE w.ownerUserId IN $participantIds
         AND $event IN w.events
         AND (w.conversationId IS NULL OR w.conversationId = $conversationId)
       RETURN w { .id, .url, .secret, .events, .conversationId } AS webhook`,
      { participantIds, event, conversationId }
    );
    return result.records.map((r) => r.get('webhook') as WebhookSubscription);
  } finally {
    await session.close();
  }
}

/**
 * Dispatch a message.created event to every matching webhook. Fire-and-forget:
 * callers should NOT await the result on the hot send path. No-ops silently
 * when there is no matching subscription.
 */
export function dispatchMessageEvent(
  message: Record<string, unknown>,
  participantIds: string[]
): void {
  const conversationId = String(message.conversationId ?? '');
  if (!conversationId) return;

  void (async () => {
    let webhooks: WebhookSubscription[];
    try {
      webhooks = await loadMatchingWebhooks(MESSAGE_CREATED_EVENT, conversationId, participantIds);
    } catch (err) {
      console.warn('[webhook] subscription lookup failed:', err);
      return;
    }

    // selectWebhooksForEvent is redundant with the Cypher filter above but keeps
    // the matching logic unit-testable and guards against query drift.
    const matches = selectWebhooksForEvent(webhooks, MESSAGE_CREATED_EVENT, conversationId);
    if (!matches.length) return;

    const body = JSON.stringify(buildMessagePayload(MESSAGE_CREATED_EVENT, message));
    await Promise.all(matches.map((w) => deliver(w, body)));
  })();
}
