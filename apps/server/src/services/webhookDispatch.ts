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
import { getDriver } from '../db.js';

export const MESSAGE_CREATED_EVENT = 'message.created';

const DELIVERY_TIMEOUT_MS = 5_000;

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

/** POST a signed payload to one webhook, with a timeout and a single retry. */
async function deliver(webhook: WebhookSubscription, body: string): Promise<void> {
  const headers = buildWebhookHeaders(body, webhook.secret);

  const attempt = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const ok = await attempt();
  if (!ok) {
    // Retry exactly once.
    const retried = await attempt();
    if (!retried) {
      console.warn(`[webhook] delivery failed after retry: ${webhook.id} -> ${webhook.url}`);
    }
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
