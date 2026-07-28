/**
 * OpenAPI 3.1 spec for the OpenChat API (openchat-8md.1).
 *
 * Hand-authored, focused on the AGENT-FACING surface (auth via JWT or an
 * `oc_` agent key through resolveActor). Served at GET /api/openapi.json, with
 * a human/agent-readable reference at GET /api/docs (Redoc).
 *
 * Not exhaustive of every internal/OAuth-flow route — it documents what an
 * external integrator, bot, or LLM needs to operate an account. Keep in sync
 * when chat/agent-keys/webhooks/feedback routes change (post-monorepo this
 * should be generated from packages/protocol).
 */

const bearer = [{ bearerAuth: [] as string[] }];
const PLAIN_REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
const KIND_REACTION_EMOJI = ['🗂️', '📁', '📎', '✅'] as const;
const REACTION_KINDS = ['filed'] as const;

const Message = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    conversationId: { type: 'string' },
    senderId: { type: 'string' },
    content: { type: 'string' },
    messageType: { type: 'string', example: 'text' },
    createdAt: { type: 'string', format: 'date-time' },
    sender: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
  },
} as const;

const Conversation = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['direct', 'group'] },
    title: { type: 'string', nullable: true },
    lastMessageAt: { type: 'string', format: 'date-time' },
    lastMessagePreview: { type: 'string' },
    containsBot: { type: 'boolean' },
    participants: { type: 'array', items: { type: 'object' } },
  },
} as const;

const AgentKey = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    keyPrefix: { type: 'string', example: 'oc_uzt9' },
    scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] } },
    createdAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
    revokedAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const AccountExport = {
  type: 'object',
  properties: {
    schema: { type: 'string', const: 'openchat.account_export.v1' },
    exportedAt: { type: 'string', format: 'date-time' },
    range: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['last_hour', 'last_day', 'last_week', 'last_month', 'all_time'] },
        label: { type: 'string' },
        since: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    user: { type: 'object' },
    conversations: { type: 'array', items: { $ref: '#/components/schemas/Conversation' } },
    messageCount: { type: 'integer' },
    messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
    thoughts: { type: 'array', items: { type: 'object' } },
    blockedUsers: { type: 'array', items: { type: 'object' } },
    agentKeys: {
      type: 'array',
      description: 'Non-secret agent key metadata owned by the exported account; plaintext keys are never included.',
      items: { $ref: '#/components/schemas/AgentKey' },
    },
  },
} as const;

const ReactionSummary = {
  type: 'object',
  properties: {
    emoji: { type: 'string', enum: [...PLAIN_REACTION_EMOJI, ...KIND_REACTION_EMOJI] },
    count: { type: 'integer' },
    byMe: { type: 'boolean' },
    kind: { type: 'string', enum: REACTION_KINDS },
    href: { type: 'string', format: 'uri' },
  },
} as const;

const AddReactionRequest = {
  type: 'object',
  properties: {
    emoji: {
      type: 'string',
      enum: [...PLAIN_REACTION_EMOJI, ...KIND_REACTION_EMOJI],
      description: `Plain reactions use ${PLAIN_REACTION_EMOJI.join(' ')}. Kind reactions use ${KIND_REACTION_EMOJI.join(' ')}.`,
    },
    kind: {
      type: 'string',
      enum: REACTION_KINDS,
      description: "Optional semantic reaction kind. `filed` requires an http(s) `href`.",
    },
    href: {
      type: 'string',
      format: 'uri',
      description: "Required for `kind: 'filed'`; must be an http(s) URL.",
    },
  },
  required: ['emoji'],
} as const;

const Webhook = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { type: 'string', enum: ['message.created'] } },
    conversationId: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const WebhookDelivery = {
  type: 'object',
  properties: {
    event: { type: 'string', enum: ['message.created'] },
    message: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conversationId: { type: 'string' },
        senderId: { type: 'string', nullable: true },
        senderName: { type: 'string', nullable: true },
        content: { type: 'string' },
        messageType: { type: 'string', example: 'text' },
        attachments: { nullable: true },
        replyToId: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  },
} as const;

const Error = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const json = (schema: unknown) => ({ 'application/json': { schema } });
const ok = (schema: unknown, description = 'OK') => ({ description, content: json(schema) });
const errResp = (description: string) => ({ description, content: json({ $ref: '#/components/schemas/Error' }) });

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'OpenChat API',
    version: '0.2.2',
    description:
      'REST API for OpenChat. Authenticate with `Authorization: Bearer <token>` where the token is either a user JWT or an `oc_` agent API key (mint one in Settings → Agent keys, or via /api/agent-keys). An agent key acts AS the owning user. Field note: message create accepts `content` (preferred) or `text` (alias). Webhook deliveries include `X-OpenChat-Secret` and `X-OpenChat-Signature` headers. Live guide: /about/connect-your-bot',
  },
  servers: [{ url: 'https://chat.globalbr.ai', description: 'production' }],
  security: bearer,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'User JWT or `oc_` agent API key.',
      },
    },
    schemas: { Message, Conversation, AgentKey, AccountExport, ReactionSummary, Webhook, WebhookDelivery, Error },
  },
  tags: [
    { name: 'Chat', description: 'Conversations and messages' },
    { name: 'Agent keys', description: 'Mint / manage `oc_` API keys' },
    { name: 'Webhooks', description: 'Outbound `message.created` subscriptions for bot channels' },
    { name: 'Feedback', description: 'In-app feedback → WorldIssueTracker' },
    { name: 'Account', description: 'Current user' },
    { name: 'Meta', description: 'Health, spec' },
  ],
  paths: {
    '/health': {
      get: { operationId: 'healthCheck', tags: ['Meta'], summary: 'Health check', security: [], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/auth/me': {
      get: { operationId: 'getMe', tags: ['Account'], summary: 'Get the authenticated user (or agent-key owner)', responses: { '200': ok({ type: 'object' }), '401': errResp('Unauthorized') } },
    },
    '/api/auth/export': {
      get: {
        operationId: 'exportAccount',
        tags: ['Account'],
        summary: 'Download an account data export',
        description: 'Requires a user JWT. The JSON bundle includes profile, conversations, range-filtered messages and thoughts, blocked users, and non-secret agent key metadata.',
        parameters: [
          { name: 'range', in: 'query', schema: { type: 'string', default: 'last_day', enum: ['last_hour', 'last_day', 'last_week', 'last_month', 'all_time'] } },
        ],
        responses: { '200': ok({ $ref: '#/components/schemas/AccountExport' }), '400': errResp('Invalid range'), '401': errResp('Unauthorized') },
      },
    },
    '/api/chat/conversations': {
      get: {
        operationId: 'listConversations',
        tags: ['Chat'],
        summary: "List the caller's conversations",
        responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Conversation' } }), '401': errResp('Unauthorized') },
      },
      post: {
        operationId: 'createConversation',
        tags: ['Chat'],
        summary: 'Create a conversation (direct or group)',
        description: 'For a self-DM, pass your own user id as the single participant.',
        requestBody: { required: true, content: json({ type: 'object', properties: { participantIds: { type: 'array', items: { type: 'string' } }, title: { type: 'string' }, type: { type: 'string', enum: ['direct', 'group'] } }, required: ['participantIds'] }) },
        responses: { '201': ok({ $ref: '#/components/schemas/Conversation' }, 'Created'), '400': errResp('Bad request'), '401': errResp('Unauthorized') },
      },
    },
    '/api/chat/conversations/{id}': {
      get: { operationId: 'getConversation', tags: ['Chat'], summary: 'Get a conversation with participants', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ $ref: '#/components/schemas/Conversation' }), '404': errResp('Not found') } },
    },
    '/api/chat/conversations/{id}/messages': {
      get: {
        operationId: 'listMessages',
        tags: ['Chat'],
        summary: 'Get messages in a conversation (paginated)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Cursor: return messages before this time' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { '200': ok({ type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } }, hasMore: { type: 'boolean' } } }), '401': errResp('Unauthorized') },
      },
      post: {
        operationId: 'sendMessage',
        tags: ['Chat'],
        summary: 'Send a message',
        description: 'Body accepts `content` (preferred) or `text` (alias). At least one of content/attachments required.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json({ type: 'object', properties: { content: { type: 'string' }, text: { type: 'string', description: 'alias for content' }, messageType: { type: 'string', default: 'text' } } }) },
        responses: { '201': ok({ $ref: '#/components/schemas/Message' }, 'Created'), '400': errResp('content or attachments required'), '401': errResp('Unauthorized') },
      },
    },
    '/api/chat/messages/since': {
      get: {
        operationId: 'pollMessagesSince',
        tags: ['Chat'],
        summary: 'Poll for new messages since a timestamp (across all conversations)',
        parameters: [{ name: 'since', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }],
        responses: { '200': ok({ type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } }), '401': errResp('Unauthorized') },
      },
    },
    '/api/chat/messages/{id}': {
      patch: { operationId: 'editMessage', tags: ['Chat'], summary: 'Edit your message', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }) }, responses: { '200': ok({ $ref: '#/components/schemas/Message' }), '403': errResp('Not your message') } },
      delete: { operationId: 'deleteMessage', tags: ['Chat'], summary: 'Delete your message (soft delete)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '403': errResp('Not your message') } },
    },
    '/api/chat/messages/{id}/reactions': {
      post: {
        operationId: 'addReaction',
        tags: ['Chat'],
        summary: 'Add a reaction to a message',
        description: 'Accepts user JWTs and `oc_` agent keys. Plain reactions use the base emoji allowlist. Kind reactions use filing glyphs (`🗂️`, `📁`, `📎`, `✅`); `kind: "filed"` requires an http(s) `href` linking to the filed resource.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json(AddReactionRequest) },
        responses: { '201': ok({ type: 'object', properties: { reactions: { type: 'array', items: { $ref: '#/components/schemas/ReactionSummary' } } } }, 'Created'), '400': errResp('Unsupported emoji'), '401': errResp('Unauthorized'), '404': errResp('Message not found') },
      },
    },
    '/api/chat/messages/{id}/reactions/{emoji}': {
      delete: {
        operationId: 'removeReaction',
        tags: ['Chat'],
        summary: 'Remove your reaction from a message',
        description: 'Accepts user JWTs and `oc_` agent keys. Omit `kind` to remove the plain reaction, or pass `kind=filed` to remove a filed receipt reaction.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'emoji', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: REACTION_KINDS } },
        ],
        responses: { '200': ok({ type: 'object', properties: { reactions: { type: 'array', items: { $ref: '#/components/schemas/ReactionSummary' } } } }), '401': errResp('Unauthorized'), '404': errResp('Message not found') },
      },
    },
    '/api/chat/contacts': {
      get: { operationId: 'listContacts', tags: ['Chat'], summary: 'List users (for starting conversations)', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: "Filter by name/email; 'self'/'me' matches the caller" }], responses: { '200': ok({ type: 'array', items: { type: 'object' } }) } },
    },
    '/api/chat/search': {
      get: { operationId: 'searchMessages', tags: ['Chat'], summary: 'Search messages', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/chat/presence': {
      put: { operationId: 'updatePresence', tags: ['Chat'], summary: 'Update your presence', requestBody: { required: true, content: json({ type: 'object', properties: { presenceStatus: { type: 'string' }, statusMessage: { type: 'string' } } }) }, responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/agent-keys': {
      get: { operationId: 'listAgentKeys', tags: ['Agent keys'], summary: 'List your agent keys (no plaintext)', responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/AgentKey' } }) } },
      post: { operationId: 'createAgentKey', tags: ['Agent keys'], summary: 'Mint a new agent key', requestBody: { required: true, content: json({ type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] } }, expiresAt: { type: 'string', format: 'date-time' } }, required: ['name'] }) }, responses: { '201': ok({ allOf: [{ $ref: '#/components/schemas/AgentKey' }, { type: 'object', properties: { key: { type: 'string', description: 'plaintext, shown once' } } }] }, 'Created') } },
    },
    '/api/agent-keys/{id}/reveal': {
      get: { operationId: 'revealAgentKey', tags: ['Agent keys'], summary: 'Reveal the plaintext key (audit-logged)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object', properties: { key: { type: 'string' } } }) } },
    },
    '/api/agent-keys/{id}': {
      patch: { operationId: 'updateAgentKey', tags: ['Agent keys'], summary: 'Rename or change scopes', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } } }) }, responses: { '200': ok({ $ref: '#/components/schemas/AgentKey' }) } },
      delete: { operationId: 'revokeAgentKey', tags: ['Agent keys'], summary: 'Revoke a key', description: 'Also deactivates outbound webhooks created by that key.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/webhooks': {
      get: {
        operationId: 'listWebhooks',
        tags: ['Webhooks'],
        summary: 'List outbound webhook subscriptions',
        description: 'Returns the caller-owned subscriptions, without secrets.',
        responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Webhook' } }), '401': errResp('Unauthorized') },
      },
      post: {
        operationId: 'createWebhook',
        tags: ['Webhooks'],
        summary: 'Create an outbound webhook subscription',
        description: 'Registers a URL for `message.created` deliveries in conversations the owner participates in. The shared secret is returned once on create.',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' },
              events: { type: 'array', items: { type: 'string', enum: ['message.created'] }, default: ['message.created'] },
              conversationId: { type: 'string', nullable: true, description: 'Optional room filter; omit/null for all conversations the owner participates in.' },
              secret: { type: 'string', description: 'Optional 1-256 character URL/header-safe shared secret.' },
            },
            required: ['url'],
          }),
        },
        responses: {
          '201': ok({ allOf: [{ $ref: '#/components/schemas/Webhook' }, { type: 'object', properties: { secret: { type: 'string', description: 'Shared secret, shown once.' } } }] }, 'Created'),
          '400': errResp('Bad request'),
          '401': errResp('Unauthorized'),
        },
      },
    },
    '/api/webhooks/{id}': {
      delete: {
        operationId: 'deleteWebhook',
        tags: ['Webhooks'],
        summary: 'Delete an outbound webhook subscription',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok({ type: 'object' }), '401': errResp('Unauthorized'), '404': errResp('Webhook not found') },
      },
    },
    '/api/feedback': {
      post: { operationId: 'submitFeedback', tags: ['Feedback'], summary: 'Submit feedback → creates a WorldIssueTracker issue', requestBody: { required: true, content: json({ type: 'object', properties: { message: { type: 'string' }, context: { type: 'string' } }, required: ['message'] }) }, responses: { '201': ok({ type: 'object', properties: { url: { type: 'string' }, id: { type: 'string' } } }, 'Created'), '400': errResp('message required'), '503': errResp('Feedback not configured (WIT_AGENT_KEY unset)') } },
    },
  },
} as const;
