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

function allowLocalWebhooks(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.WEBHOOK_ALLOW_LOCAL ?? '').toLowerCase());
}

export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  events: string[];
  conversationId: string | null;
  deactivatedAt?: string | null;
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
    viaSecretary: boolean;
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
      viaSecretary: message.viaSecretary === true,
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
    if (w.deactivatedAt) return false;
    const subscribed = Array.isArray(w.events) && w.events.includes(event);
    if (!subscribed) return false;
    return w.conversationId == null || w.conversationId === conversationId;
  });
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return parts;
}

function isPublicIPv4(address: string): boolean {
  const parts = parseIPv4(address);
  if (!parts) return false;

  const [a, b] = parts;
  const blocked =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && parts[2] === 99) ||
    (a === 169 && b === 254) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224;
  return !blocked;
}

function isLoopbackIPv4(address: string): boolean {
  const parts = parseIPv4(address) ?? [];
  return parts.length === 4 && parts[0] === 127;
}

function parseIPv6Bytes(address: string): number[] | null {
  if (net.isIP(address) !== 6) return null;

  let normalized = address.toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const v4 = parseIPv4(normalized.slice(lastColon + 1));
    if (!v4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((v4[0] << 8) | v4[1]).toString(16)}:${(
      (v4[2] << 8) |
      v4[3]
    ).toString(16)}`;
  }

  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;

  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null;

  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function mappedIPv4FromIPv6(address: string): string | null {
  const bytes = parseIPv6Bytes(address);
  if (!bytes) return null;

  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (!isMapped) return null;
  return bytes.slice(12).join('.');
}

function isPublicIPv6(address: string): boolean {
  const mapped = mappedIPv4FromIPv6(address);
  if (mapped) return isPublicIPv4(mapped);

  const bytes = parseIPv6Bytes(address);
  if (!bytes) return false;

  const allZero = bytes.every((b) => b === 0);
  if (allZero) return false;

  const first16 = (bytes[0] << 8) | bytes[1];
  const first32 = first16 * 0x10000 + ((bytes[2] << 8) | bytes[3]);
  const first48 = first32 * 0x10000 + ((bytes[4] << 8) | bytes[5]);

  if (first16 === 0x2001 && ((bytes[2] << 8) | bytes[3]) === 0x0db8) return false;
  if (first48 === 0x200100000002) return false;
  if (first16 === 0x2001 && bytes[2] === 0 && (bytes[3] & 0xf0) === 0x10) return false;
  if (first16 === 0x2002) return false;

  return (first16 & 0xe000) === 0x2000;
}

function isLoopbackIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  const mapped = mappedIPv4FromIPv6(address);
  return mapped ? isLoopbackIPv4(mapped) : false;
}

function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !isPublicIPv4(address);
  if (family === 6) return !isPublicIPv6(address);
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
    if (allowLocalWebhooks() && isLoopbackAddress(hostname)) {
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
    if (allowLocalWebhooks() && allLoopback) {
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
          const localAllowed = allowLocalWebhooks();
          if (!localAllowed && isBlockedAddress(target.address)) {
            callback(new Error('Blocked webhook target address'), target.address, target.family);
            return;
          }
          if (localAllowed && !isLoopbackAddress(target.address) && isBlockedAddress(target.address)) {
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

async function deliverSafely(webhook: WebhookSubscription, body: string): Promise<void> {
  try {
    await deliver(webhook, body);
  } catch (err) {
    console.warn(`[webhook] delivery crashed: ${webhook.id} -> ${webhook.url}`, err);
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
         AND w.deactivatedAt IS NULL
         AND $event IN w.events
         AND (w.conversationId IS NULL OR w.conversationId = $conversationId)
       RETURN w { .id, .url, .secret, .events, .conversationId, .deactivatedAt } AS webhook`,
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
    await Promise.all(matches.map((w) => deliverSafely(w, body)));
  })();
}
