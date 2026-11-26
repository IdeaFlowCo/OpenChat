/**
 * Personal Secretary mode (OpenChat-3kr.3.1).
 *
 * A user can opt in and store a small set of owner-written question/answer
 * cards. When another human sends a message in a one-to-one direct chat, this
 * service deterministically matches the message to one of those cards and
 * posts the exact approved answer on the owner's behalf. It never asks an LLM
 * to infer private information and never searches unrelated conversations.
 */

import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { broadcastMessageToParticipants, isUserOnline } from '../websocket/chatHandler.js';
import { runAutoResponses } from './autoResponses.js';
import { dispatchMessageEvent } from './webhookDispatch.js';
import { findSecretaryAnswer, type SecretaryAnswer } from './secretaryMatcher.js';

// Per-owner sliding-window limit. The source-message idempotency check below
// prevents duplicate replies; this limit additionally bounds abusive senders.
const MAX_REPLIES_PER_MINUTE = 10;
const replyTimes = new Map<string, number[]>();

function isRateLimited(ownerId: string): boolean {
  const now = Date.now();
  const recent = (replyTimes.get(ownerId) ?? []).filter((time) => time > now - 60_000);
  if (recent.length >= MAX_REPLIES_PER_MINUTE) {
    replyTimes.set(ownerId, recent);
    return true;
  }
  recent.push(now);
  replyTimes.set(ownerId, recent);
  return false;
}

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
    return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, toJS(item)]));
  }
  return value;
}

type SecretaryTrigger = {
  senderId: string;
  conversationId: string;
  sourceMessageId: string;
  content: string;
  io?: IOServer;
};

/**
 * Secretary first (exact owner-approved answers). When it does not answer,
 * the owner's auto-response rules get a chance (owner-approved draft by default).
 */
export function maybeTriggerSecretary(opts: SecretaryTrigger): void {
  if (!opts.content.trim()) return;
  void runSecretary(opts)
    .then(async (replied) => {
      if (replied) return;
      await runAutoResponses({ ...opts, driver: getDriver(), isOnline: isUserOnline, broadcast: broadcastMessageToParticipants });
    })
    .catch(() => undefined);
}

/** Resolves true when Secretary handled (or deliberately throttled) this message. */
async function runSecretary(opts: SecretaryTrigger): Promise<boolean> {
  const { senderId, conversationId, sourceMessageId, content, io } = opts;
  {
    const session = getDriver().session();
    try {
      // Direct chats only. A real human owner must be the one other human in
      // the chat, and must have explicitly enabled Secretary mode.
      const result = await session.run(
        `MATCH (sender:User {id: $senderId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId, type: 'direct'})
         MATCH (owner:User)-[:PARTICIPATES_IN]->(c)
         WHERE owner.id <> $senderId
           AND coalesce(owner.isBot, false) = false
           AND coalesce(owner.secretaryEnabled, false) = true
         OPTIONAL MATCH (owner)-[:OWNS_SECRETARY_ANSWER]->(entry:SecretaryAnswer)
         RETURN owner { .id, .name } AS owner,
                collect(entry { .id, .question, .answer, .createdAt, .updatedAt }) AS answers
         LIMIT 1`,
        { senderId, conversationId }
      );
      if (result.records.length === 0) return false;

      const owner = toJS(result.records[0]!.get('owner')) as { id: string; name?: string };
      const answers = (toJS(result.records[0]!.get('answers')) as SecretaryAnswer[])
        .filter((entry) => entry?.id && entry.question && entry.answer);
      const match = findSecretaryAnswer(content, answers);
      if (!match) return false;
      if (isRateLimited(owner.id)) return true;

      const messageId = nanoid();
      const now = new Date().toISOString();
      // The NOT EXISTS guard makes the reply idempotent even if a client send
      // is retried or both transport paths somehow observe the same source.
      const persisted = await session.run(
        `MATCH (c:Conversation {id: $conversationId})
         MATCH (owner:User {id: $ownerId})
         MATCH (source:Message {id: $sourceMessageId, conversationId: $conversationId})
         WHERE NOT EXISTS {
           MATCH (existing:Message {secretarySourceMessageId: $sourceMessageId})
         }
         CREATE (m:Message {
           id: $messageId,
           content: $content,
           senderId: $ownerId,
           conversationId: $conversationId,
           messageType: 'text',
           viaSecretary: true,
           secretarySourceMessageId: $sourceMessageId,
           secretaryAnswerId: $answerId,
           createdAt: datetime($now)
         })
         CREATE (m)-[:IN_CONVERSATION]->(c)
         CREATE (owner)-[:SENT]->(m)
         SET c.updatedAt = datetime($now),
             c.lastMessageAt = datetime($now),
             c.lastMessagePreview = left($content, 100)
         WITH c, m, owner
         MATCH (participant:User)-[:PARTICIPATES_IN]->(c)
         RETURN m { .*, sender: owner { .id, .name, .avatarUrl } } AS message,
                collect(DISTINCT participant.id) AS participantIds`,
        {
          conversationId,
          ownerId: owner.id,
          sourceMessageId,
          messageId,
          content: match.answer.trim(),
          answerId: match.id,
          now,
        }
      );
      if (persisted.records.length === 0) return true;

      const message = toJS(persisted.records[0]!.get('message')) as Record<string, unknown>;
      const participantIds = persisted.records[0]!.get('participantIds') as string[];
      // The reply is saved: from here on it counts as handled even if delivery fan-out fails.
      try {
        if (io) await broadcastMessageToParticipants(io, conversationId, message);
        dispatchMessageEvent(message, participantIds);
      } catch (error) {
        console.warn('[secretary] delivery after save failed:', error);
      }
      console.log('[secretary] auto_reply', JSON.stringify({
        ownerId: owner.id,
        conversationId,
        sourceMessageId,
        answerId: match.id,
      }));
      return true;
    } catch (error) {
      console.warn('[secretary] auto-reply failed:', error);
      return false;
    } finally {
      await session.close();
    }
  }
}
