import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { broadcastMessageToParticipants, fanoutPushForMessage } from '../websocket/chatHandler.js';
import { notifyDirectConversationParticipants } from './directConversation.js';
import { processLinkPreviews } from './linkPreview.js';
import { createThoughtsFromMessageTags } from './extractThoughtsFromMessage.js';
import { embedAndStoreMessage } from './embeddings.js';
import { dispatchMessageEvent } from './webhookDispatch.js';
import { maybeTriggerAssistant } from './assistantTrigger.js';
import { maybeTriggerSecretary } from './secretary.js';
import type { ConnectorTextResult } from './connectorTextSend.js';

/** Existing normal text-message fanout, after a fresh committed write only.
 * Matching durable receipts never recreate content or fire these effects. */
export function publishConnectorText(result: ConnectorTextResult, io?: IOServer): void {
  const { message, participantIds, receipt } = result;
  if (!message || receipt.replayed) return;
  const senderId = message.senderId as string;
  const content = message.content as string;
  const conversationId = receipt.conversationId;
  if (result.createdDirect)
    notifyDirectConversationParticipants(io, result.createdDirect.conversation, participantIds, result.createdDirect.created);
  if (io) broadcastMessageToParticipants(io, participantIds, message);
  void fanoutPushForMessage(conversationId, senderId, message)
    .catch(() => console.warn('[connector-text] push unavailable'));
  dispatchMessageEvent(message, participantIds);
  if (io) processLinkPreviews(io, receipt.messageId, conversationId, content);
  const tagSession = getDriver().session();
  void createThoughtsFromMessageTags(tagSession, { senderId, messageId: receipt.messageId,
    conversationId, content, replyToId: message.replyToId as string | null ?? null, io })
    .catch(() => console.warn('[connector-text] thought extraction unavailable'))
    .finally(() => { void tagSession.close(); });
  void embedAndStoreMessage(receipt.messageId, content)
    .catch(() => console.warn('[connector-text] embedding unavailable'));
  maybeTriggerAssistant({ senderId, conversationId, io });
  maybeTriggerSecretary({ senderId, conversationId, sourceMessageId: receipt.messageId, content, io });
}
