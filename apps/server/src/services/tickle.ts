/**
 * Tickle (OpenChat-m0xp) — a WeChat "pat" / Facebook "poke" style nudge.
 *
 * A tickle is a server-authored system card in the conversation
 * (`messageType: 'card'`, `cardKind: 'tickle'`) plus a push to the person
 * tickled. Clients render the card as a centered line ("Jacob tickled you")
 * and, when they are the target, shake and buzz. Cards are server-internal,
 * so this is the only way one is created; the socket event just asks for it.
 */

import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { persistMessage } from './assistant.js';
import { sendPushToUser } from './push.js';

/** Minimum gap between two tickles from the same person to the same person. */
export const TICKLE_COOLDOWN_MS = 3000;

export interface TicklePayload {
  fromUserId: string;
  toUserId: string;
  fromName: string;
  toName: string;
}

const lastTickleAt = new Map<string, number>();

/** Pure cooldown gate; records the attempt when allowed. */
export function tickleAllowed(fromUserId: string, toUserId: string, now = Date.now()): boolean {
  const key = `${fromUserId}\u0000${toUserId}`;
  const last = lastTickleAt.get(key);
  if (last !== undefined && now - last < TICKLE_COOLDOWN_MS) return false;
  lastTickleAt.set(key, now);
  // Keep the map from growing without bound on a long-lived process.
  if (lastTickleAt.size > 5000) {
    for (const [k, at] of lastTickleAt) if (now - at > TICKLE_COOLDOWN_MS) lastTickleAt.delete(k);
  }
  return true;
}

export function resetTickleCooldowns(): void {
  lastTickleAt.clear();
}

export function tickleContent(fromName: string, toName: string): string {
  return `${fromName} tickled ${toName}`;
}

export type TickleResult =
  | { ok: true; dropped?: boolean; message?: Record<string, unknown> }
  | { ok: false; error: 'invalid_target' | 'not_participant' | 'too_soon' };

export async function sendTickle(
  io: IOServer | undefined,
  fromUserId: string,
  conversationId: string,
  toUserId: string,
): Promise<TickleResult> {
  if (!toUserId || toUserId === fromUserId) return { ok: false, error: 'invalid_target' };
  if (!tickleAllowed(fromUserId, toUserId)) return { ok: false, error: 'too_soon' };

  const session = getDriver().session();
  try {
    // Both people must be in the conversation; blocks in either direction
    // drop the tickle silently, exactly like a blocked message send.
    const result = await session.run(`
      MATCH (me:User {id: $fromUserId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      MATCH (them:User {id: $toUserId})-[rel:PARTICIPATES_IN]->(c)
      RETURN me.name AS fromName, them.name AS toName, them.isBot AS isBot,
             rel.mutedUntil AS mutedUntil,
             ((me)-[:BLOCKED]->(them) OR (them)-[:BLOCKED]->(me)) AS blocked
    `, { fromUserId, conversationId, toUserId });
    if (result.records.length === 0) return { ok: false, error: 'not_participant' };
    const record = result.records[0];
    if (record.get('isBot') === true) return { ok: false, error: 'invalid_target' };
    if (record.get('blocked') === true) return { ok: true, dropped: true };

    const fromName = ((record.get('fromName') as string | null) || 'Someone').trim();
    const toName = ((record.get('toName') as string | null) || 'someone').trim();
    const payload: TicklePayload = { fromUserId, toUserId, fromName, toName };
    const persisted = await persistMessage(io, fromUserId, conversationId, tickleContent(fromName, toName), {
      messageType: 'card',
      cardKind: 'tickle',
      cardPayload: JSON.stringify(payload),
    });
    if (!persisted) return { ok: false, error: 'not_participant' };

    const mutedUntil = record.get('mutedUntil') as string | null;
    const muted = mutedUntil === 'always'
      || (typeof mutedUntil === 'string' && !Number.isNaN(Date.parse(mutedUntil)) && Date.now() < Date.parse(mutedUntil));
    if (!muted) {
      void sendPushToUser(toUserId, {
        title: fromName,
        body: `${fromName} tickled you`,
        tag: `tickle:${conversationId}`,
        data: { type: 'tickle', conversationId, messageId: persisted.message.id as string },
      }).catch((err) => console.warn('[tickle] push failed:', err));
    }
    return { ok: true, message: persisted.message };
  } finally {
    await session.close();
  }
}
