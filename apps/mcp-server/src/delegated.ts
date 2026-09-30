import { z } from 'zod';
import { createApi } from './api.js';
import { CONNECTOR_TOOL_NAMES, getMessagesSchema, searchMessagesSchema, sendMessageSchema,
  type ConnectorToolName } from './connectorTools.js';

export interface ConnectorInvocation {
  connectorGrantId: string;
  connectorUserId: string;
  openChatUserId: string;
}
export interface ResolvedDelegation extends ConnectorInvocation {
  token: string;
  scopes: Array<'openchat.read' | 'openchat.send'>;
  expiresAt: number;
}
export type DelegationResolver = (invocation: ConnectorInvocation) => Promise<ResolvedDelegation | null>;
export interface ConnectorToolResult { isError?: boolean; content: Array<{ type: 'text'; text: string }> }

const asText = (value: unknown): ConnectorToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const denied = (): ConnectorToolResult => ({ isError: true, content: [{ type: 'text', text: 'OpenChat delegation denied' }] });
const unavailable = (): ConnectorToolResult => ({ isError: true, content: [{ type: 'text', text: 'OpenChat request failed' }] });

/** A single relying-party request must resolve its own grant; no global key or cache is read. */
export function createDelegatedConnector(options: { upstreamOrigin: string; resolve: DelegationResolver }) {
  const origin = new URL(options.upstreamOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid fixed upstream origin');
  const baseUrl = origin.origin;
  return {
    toolNames: CONNECTOR_TOOL_NAMES,
    async call(invocation: ConnectorInvocation, name: string, rawArgs: unknown): Promise<ConnectorToolResult> {
      if (!CONNECTOR_TOOL_NAMES.includes(name as ConnectorToolName)) return denied();
      try {
        const delegation = await options.resolve(invocation);
        if (!delegation || delegation.connectorGrantId !== invocation.connectorGrantId
          || delegation.connectorUserId !== invocation.connectorUserId
          || delegation.openChatUserId !== invocation.openChatUserId
          || delegation.expiresAt <= Date.now() || !delegation.token.startsWith('ocd_')) return denied();
        const scope = name === 'oc_send_message' ? 'openchat.send' : 'openchat.read';
        if (!delegation.scopes.includes(scope)) return denied();
        // createApi is the existing typed REST adapter; its config is constructed from
        // this server's fixed origin and the credential resolved for this one call.
        const api = createApi({ baseUrl, apiKey: delegation.token });
        switch (name) {
          case 'oc_list_conversations':
            z.object({}).strict().parse(rawArgs ?? {});
            return asText(await api.listConversations());
          case 'oc_get_messages': {
            const args = z.object(getMessagesSchema).strict().parse(rawArgs);
            return asText(await api.getMessages(args.conversationId, args.limit));
          }
          case 'oc_search_messages': {
            const args = z.object(searchMessagesSchema).strict().parse(rawArgs);
            return asText(await api.searchMessages(args.query, args.limit));
          }
          case 'oc_send_message': {
            const args = z.object(sendMessageSchema).strict().parse(rawArgs);
            if (!args.clientRequestId || !args.text.trim()) return denied();
            const message = await api.sendMessage(args.conversationId,
              { content: args.text, clientRequestId: args.clientRequestId });
            return asText({ id: message.id, senderId: message.senderId, content: message.content,
              conversationId: message.conversationId, createdAt: message.createdAt });
          }
        }
      } catch {
        // API errors may contain server details or reflected headers. Tool output is fixed.
        return unavailable();
      }
      return denied();
    },
  };
}
