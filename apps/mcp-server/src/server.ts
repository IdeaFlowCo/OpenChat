/**
 * Shared server-construction logic for the OpenChat MCP server.
 *
 * Both entrypoints (`src/index.ts` for stdio, `src/http.ts` for HTTP)
 * call `buildServer(config)` to get a fully-wired `McpServer`. Each call
 * returns a fresh instance bound to its own API client — no key leakage
 * across concurrent sessions on the HTTP transport.
 *
 * Tools registered:
 *   oc_list_conversations   — list your conversations
 *   oc_get_messages         — recent messages from a conversation
 *   oc_send_message         — send a message (write)
 *   oc_search_messages      — full-text search across messages/conversations/contacts
 *   oc_list_contacts        — list/filter contacts
 *   oc_create_conversation  — create a direct or group conversation (write)
 *   oc_submit_feedback      — file feedback about OpenChat (write)
 *   oc_react                — add emoji reaction (write)
 *   oc_create_dm            — start or retrieve a 1:1 DM (write)
 *   oc_register_agent       — mint a new agent API key (write)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  createApi,
  OpenChatApiError,
  type OpenChatApi,
  type OpenChatConfig,
  type ConversationSummary,
  type Message,
  type Contact,
  type SearchMessageHit,
} from './api.js';

export const VERSION = '0.1.0';

// ---- formatting helpers ----

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(e: unknown) {
  if (e instanceof OpenChatApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `OpenChat API error (${e.status}): ${e.body.slice(0, 500)}\nURL: ${e.url}`,
        },
      ],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
}

function requireApiKey(api: OpenChatApi, purpose: string) {
  if (!api.hasApiKey) {
    throw new Error(
      `OPENCHAT_API_KEY is not set. ${purpose} requires authentication. ` +
        `Set OPENCHAT_API_KEY in your environment or create ~/.openchat/credentials.json.`
    );
  }
}

function formatConversation(c: ConversationSummary): string {
  const parts: string[] = [];
  parts.push(`id: ${c.id}`);
  if (c.title) parts.push(`title: ${c.title}`);
  if (c.type) parts.push(`type: ${c.type}`);
  if (c.lastMessageAt) parts.push(`lastMessageAt: ${c.lastMessageAt}`);
  if (c.lastMessage?.content) {
    parts.push(`lastMessage: ${String(c.lastMessage.content).slice(0, 100)}`);
  }
  const participantNames = (c.participants || [])
    .map((p) => p.user?.name || p.user?.email || p.user?.id || '?')
    .join(', ');
  if (participantNames) parts.push(`participants: ${participantNames}`);
  return parts.join(' | ');
}

function formatMessage(m: Message): string {
  const sender = m.sender?.name || m.sender?.email || m.senderId || 'unknown';
  const time = m.createdAt ? ` [${m.createdAt}]` : '';
  const reactions =
    m.reactions && m.reactions.length > 0
      ? ' ' + m.reactions.map((r) => `${r.emoji}×${r.count}`).join(' ')
      : '';
  return `[${m.id}]${time} ${sender}: ${m.content || '(no content)'}${reactions}`;
}

function formatSearchHit(m: SearchMessageHit): string {
  const sender = m.sender?.name || m.sender?.email || m.senderId || 'unknown';
  const time = m.createdAt ? ` [${m.createdAt}]` : '';
  const convo = m.conversationTitle
    ? ` in "${m.conversationTitle}"`
    : m.conversationId
      ? ` in conv ${m.conversationId}`
      : '';
  return `[${m.id}]${time} ${sender}${convo}: ${m.content || '(no content)'}`;
}

function formatContact(c: Contact): string {
  const parts: string[] = [`id: ${c.id}`];
  if (c.name) parts.push(`name: ${c.name}`);
  if (c.email) parts.push(`email: ${c.email}`);
  if (c.presenceStatus) parts.push(`presence: ${c.presenceStatus}`);
  if (c.isBot) parts.push('bot');
  return parts.join(' | ');
}

// ---- builder ----

/**
 * Build a fresh `McpServer` bound to the given OpenChat config.
 *
 * The returned server has no transport attached — the caller connects it
 * to stdio or HTTP.
 */
export function buildServer(
  config: OpenChatConfig,
  options: { instructions?: string } = {}
): McpServer {
  const api = createApi(config);

  const server = new McpServer(
    { name: 'openchat', version: VERSION },
    options.instructions ? { instructions: options.instructions } : {}
  );

  // ---- oc_list_conversations ----
  server.registerTool(
    'oc_list_conversations',
    {
      title: 'List conversations',
      description:
        'Return all conversations the authenticated user participates in, ordered by most-recent activity. ' +
        'Each entry includes id, title, type (direct|group), lastMessageAt, and a preview of the last message.',
      inputSchema: {},
    },
    async () => {
      try {
        requireApiKey(api, 'Listing conversations');
        const conversations = await api.listConversations();
        if (!conversations.length) {
          return textResult('No conversations found.');
        }
        return textResult(
          `${conversations.length} conversation(s):\n` +
            conversations.map(formatConversation).join('\n')
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_get_messages ----
  server.registerTool(
    'oc_get_messages',
    {
      title: 'Get messages',
      description:
        'Return recent messages from a conversation. Includes sender, timestamp, content, and emoji reactions. ' +
        'Messages are returned in chronological order (oldest first).',
      inputSchema: {
        conversationId: z.string().min(1).describe('The conversation id'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(50)
          .describe('Maximum number of messages to return (default 50, max 200)'),
      },
    },
    async ({ conversationId, limit }) => {
      try {
        requireApiKey(api, 'Reading messages');
        const messages = await api.getMessages(conversationId, limit);
        if (!messages.length) {
          return textResult(`No messages in conversation ${conversationId}.`);
        }
        return textResult(
          `${messages.length} message(s) in ${conversationId}:\n` +
            messages.map(formatMessage).join('\n')
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_send_message ----
  server.registerTool(
    'oc_send_message',
    {
      title: 'Send a message',
      description:
        'Send a message to a conversation. Returns the created message with its id and timestamp.',
      inputSchema: {
        conversationId: z.string().min(1).describe('The conversation id'),
        text: z.string().min(1).describe('Message text content'),
        attachments: z
          .array(z.unknown())
          .optional()
          .describe('Optional array of attachment objects (reserved for future use)'),
      },
    },
    async ({ conversationId, text, attachments }) => {
      try {
        requireApiKey(api, 'Sending messages');
        const body: { content: string; attachments?: unknown[] } = { content: text };
        if (attachments && attachments.length > 0) body.attachments = attachments;
        const msg = await api.sendMessage(conversationId, body);
        return textResult(
          `Message sent.\nid: ${msg.id}\ncreatedAt: ${msg.createdAt || 'unknown'}`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_search_messages ----
  server.registerTool(
    'oc_search_messages',
    {
      title: 'Search messages',
      description:
        'Full-text search across the messages, conversations, and contacts the authenticated user can see. ' +
        'Maps to GET /api/chat/search. Returns matching message hits (with sender, conversation, and timestamp), ' +
        'plus any matching conversations and contacts.',
      inputSchema: {
        query: z.string().min(1).describe('Search query string'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(20)
          .describe('Maximum number of message hits to return (default 20, max 200)'),
      },
    },
    async ({ query, limit }) => {
      try {
        requireApiKey(api, 'Searching messages');
        const result = await api.searchMessages(query, limit);
        const messages = result.messages ?? [];
        const conversations = result.conversations ?? [];
        const contacts = result.contacts ?? [];

        if (!messages.length && !conversations.length && !contacts.length) {
          return textResult(`No results for "${query}".`);
        }

        const sections: string[] = [];
        if (messages.length) {
          sections.push(
            `Messages (${messages.length}):\n` + messages.map(formatSearchHit).join('\n')
          );
        }
        if (conversations.length) {
          sections.push(
            `Conversations (${conversations.length}):\n` +
              conversations.map(formatConversation).join('\n')
          );
        }
        if (contacts.length) {
          sections.push(
            `Contacts (${contacts.length}):\n` + contacts.map(formatContact).join('\n')
          );
        }
        return textResult(`Results for "${query}":\n\n` + sections.join('\n\n'));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_list_contacts ----
  server.registerTool(
    'oc_list_contacts',
    {
      title: 'List contacts',
      description:
        'List the contacts (users) available to the authenticated user. Maps to GET /api/chat/contacts. ' +
        'Pass an optional query to filter by name or email; the special value "me" or "self" matches the caller. ' +
        'Each entry includes id, name, email, and presence — use the id with oc_create_conversation.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional filter by name/email. "me" or "self" matches the caller.'),
      },
    },
    async ({ query }) => {
      try {
        requireApiKey(api, 'Listing contacts');
        const contacts = await api.listContacts(query);
        if (!contacts.length) {
          return textResult(query ? `No contacts match "${query}".` : 'No contacts found.');
        }
        return textResult(
          `${contacts.length} contact(s):\n` + contacts.map(formatContact).join('\n')
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_create_conversation ----
  server.registerTool(
    'oc_create_conversation',
    {
      title: 'Create a conversation',
      description:
        'Create a new direct or group conversation. Maps to POST /api/chat/conversations. ' +
        'Provide one or more participant user ids (find them with oc_list_contacts or oc_search_messages). ' +
        'For a 1:1 DM by email address, prefer oc_create_dm. Returns the conversation id for oc_send_message.',
      inputSchema: {
        participantIds: z
          .array(z.string().min(1))
          .min(1)
          .describe('User ids to include (the caller is added automatically)'),
        title: z.string().optional().describe('Optional title (recommended for group conversations)'),
        type: z
          .enum(['direct', 'group'])
          .optional()
          .describe('Conversation type. Defaults server-side based on participant count.'),
      },
    },
    async ({ participantIds, title, type }) => {
      try {
        requireApiKey(api, 'Creating conversations');
        const conversation = await api.createConversation({ participantIds, title, type });
        return textResult(
          `Conversation ready.\nconversationId: ${conversation.id}` +
            (conversation.title ? `\ntitle: ${conversation.title}` : '') +
            (conversation.type ? `\ntype: ${conversation.type}` : '')
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_submit_feedback ----
  server.registerTool(
    'oc_submit_feedback',
    {
      title: 'Submit feedback',
      description:
        'File feedback (bug report, feature request, or note) about OpenChat. Maps to POST /api/feedback. ' +
        'Returns a URL/id for the created feedback item when available.',
      inputSchema: {
        message: z.string().min(1).describe('The feedback message'),
        context: z
          .string()
          .optional()
          .describe('Optional extra context, e.g. page, conversation id, or steps to reproduce'),
      },
    },
    async ({ message, context }) => {
      try {
        requireApiKey(api, 'Submitting feedback');
        const result = await api.submitFeedback({ message, context });
        const lines = ['Feedback submitted.'];
        if (result?.id) lines.push(`id: ${result.id}`);
        if (result?.url) lines.push(`url: ${result.url}`);
        return textResult(lines.join('\n'));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_react ----
  server.registerTool(
    'oc_react',
    {
      title: 'Add emoji reaction',
      description:
        'Add an emoji reaction to a message. Reactions are idempotent — re-adding the same emoji is a no-op.',
      inputSchema: {
        messageId: z.string().min(1).describe('The message id to react to'),
        emoji: z.string().min(1).describe('The emoji character(s), e.g. "👍" or "❤️"'),
      },
    },
    async ({ messageId, emoji }) => {
      try {
        requireApiKey(api, 'Adding reactions');
        await api.addReaction(messageId, emoji);
        return textResult(`Reaction ${emoji} added to message ${messageId}.`);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_create_dm ----
  server.registerTool(
    'oc_create_dm',
    {
      title: 'Create or open a 1:1 DM',
      description:
        'Look up a user by email address and open (or return the existing) direct-message conversation with them. ' +
        'Returns the conversation id for use with oc_send_message.',
      inputSchema: {
        userEmail: z.string().email().describe('Email address of the person to DM'),
      },
    },
    async ({ userEmail }) => {
      try {
        requireApiKey(api, 'Creating DMs');

        // Step 1: resolve email → user id
        let targetUser;
        try {
          targetUser = await api.getUserByEmail(userEmail);
        } catch (e) {
          if (e instanceof OpenChatApiError && e.status === 404) {
            return textResult(`No OpenChat user found with email "${userEmail}".`);
          }
          throw e;
        }

        // Step 2: create (or get existing) DM conversation
        const conversation = await api.createConversation({
          participantIds: [targetUser.id],
          type: 'direct',
        });

        return textResult(
          `DM conversation with ${targetUser.name || userEmail} is ready.\n` +
            `conversationId: ${conversation.id}`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- oc_register_agent ----
  server.registerTool(
    'oc_register_agent',
    {
      title: 'Register an agent API key',
      description:
        'Mint a new OpenChat agent API key under your account. ' +
        'The key can be used as OPENCHAT_API_KEY in any MCP client or as a Bearer token in the REST API. ' +
        'NOTE: This depends on the /api/agent-keys endpoint (OpenChat-7c9). ' +
        'If that endpoint is not yet deployed, this tool will say so and tell you how to create a key manually.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(80)
          .describe('Human-readable name for this key, e.g. "my-claude-agent"'),
        scopes: z
          .array(z.string())
          .optional()
          .describe('Array of scope strings, e.g. ["read", "write"]. Defaults to ["read","write"].'),
        expiresAt: z
          .string()
          .optional()
          .describe('ISO 8601 expiry timestamp, e.g. "2027-01-01T00:00:00Z". Omit for no expiry.'),
      },
    },
    async ({ name, scopes, expiresAt }) => {
      try {
        requireApiKey(api, 'Creating agent keys');

        // Probe whether the agent-keys endpoint exists yet
        let endpointAvailable = false;
        try {
          await api.listAgentKeys();
          endpointAvailable = true;
        } catch (e) {
          if (e instanceof OpenChatApiError && (e.status === 404 || e.status === 501)) {
            endpointAvailable = false;
          } else {
            // 401/403/5xx — endpoint exists but there was another error
            endpointAvailable = true;
          }
        }

        if (!endpointAvailable) {
          return textResult(
            'The /api/agent-keys endpoint is not yet deployed on this OpenChat instance.\n' +
              'This feature is tracked as OpenChat-7c9 (self-serve agent API keys).\n\n' +
              'Until it ships, you can create a key manually:\n' +
              '  1. Open OpenChat in your browser\n' +
              '  2. Go to Settings → Agent Keys\n' +
              '  3. Click "New key", enter a name, and copy the generated oc_… token\n' +
              '  4. Set it as OPENCHAT_API_KEY in your MCP client config'
          );
        }

        const result = await api.createAgentKey({
          name,
          scopes: scopes ?? ['read', 'write'],
          expiresAt,
        });

        return textResult(
          [
            `Created agent key "${result.name}".`,
            `key: ${result.key}`,
            `id:  ${result.id}`,
            '',
            'Save this key — use it as OPENCHAT_API_KEY in your MCP client config or',
            'pass it via Authorization: Bearer <key> when calling the OpenChat REST API.',
          ].join('\n')
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  return server;
}
