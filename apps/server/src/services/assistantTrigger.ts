/**
 * Assistant trigger (openchat-bfn.3).
 *
 * Shared by the REST messages route and the socket 'message:send' handler.
 * After a HUMAN message is persisted into a conversation, this checks whether
 * the conversation contains the assistant bot and, if so, fires
 * runAssistantTurn asynchronously (never blocking the send).
 *
 * CRITICAL loop guard: we no-op when the sender IS the assistant, so the
 * assistant's own replies never re-arm the trigger.
 */

import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { runAssistantTurn, ASSISTANT_USER_ID } from './assistant.js';

export function maybeTriggerAssistant(opts: {
  senderId: string;
  conversationId: string;
  io?: IOServer;
}): void {
  const { senderId, conversationId, io } = opts;

  // Never trigger on the bot's own messages (prevents infinite loops).
  if (senderId === ASSISTANT_USER_ID) return;

  // Best-effort, fully async — do not block the send. Own session.
  void (async () => {
    const s = getDriver().session();
    let containsBot = false;
    try {
      const result = await s.run(
        `MATCH (c:Conversation {id: $conversationId})
         RETURN EXISTS {
           MATCH (bot:User)-[:PARTICIPATES_IN]->(c) WHERE bot.isBot = true
         } AS containsBot`,
        { conversationId }
      );
      containsBot = result.records[0]?.get('containsBot') === true;
    } catch (err) {
      console.warn('[assistant-trigger] containsBot check failed:', err);
      return;
    } finally {
      await s.close();
    }

    if (!containsBot) return;

    runAssistantTurn({ userId: senderId, conversationId, io }).catch((err) =>
      console.error('[assistant-trigger] runAssistantTurn error:', err)
    );
  })();
}
