import { z } from 'zod';

/** The only tools eligible for the optional connector delegation. */
export const CONNECTOR_TOOL_NAMES = [
  'oc_list_conversations', 'oc_get_messages', 'oc_search_messages', 'oc_send_message',
] as const;
export type ConnectorToolName = typeof CONNECTOR_TOOL_NAMES[number];

export const getMessagesSchema = {
  conversationId: z.string().min(1).describe('The conversation id'),
  limit: z.number().int().min(1).max(200).optional().default(50),
};
export const searchMessagesSchema = {
  query: z.string().min(1).describe('Message/conversation query'),
  limit: z.number().int().min(1).max(200).optional().default(20),
};
export const sendMessageSchema = {
  conversationId: z.string().min(1).describe('The conversation id'),
  text: z.string().min(1).describe('Message text content'),
  clientRequestId: z.string().min(1).max(200).optional().describe('Stable idempotency key for connector retries'),
};
