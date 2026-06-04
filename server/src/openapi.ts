/**
 * OpenAPI 3.1 spec for the OpenChat API (openchat-8md.1).
 *
 * Hand-authored, focused on the AGENT-FACING surface (auth via JWT or an
 * `oc_` agent key through resolveActor). Served at GET /api/openapi.json, with
 * a human/agent-readable reference at GET /api/docs (Redoc).
 *
 * Not exhaustive of every internal/OAuth-flow route — it documents what an
 * external integrator, bot, or LLM needs to operate an account. Keep in sync
 * when chat/agent-keys/feedback routes change (post-monorepo this should be
 * generated from packages/protocol).
 */

const bearer = [{ bearerAuth: [] as string[] }];

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
      'REST API for OpenChat. Authenticate with `Authorization: Bearer <token>` where the token is either a user JWT or an `oc_` agent API key (mint one in Settings → Agent keys, or via /api/agent-keys). An agent key acts AS the owning user. Field note: message create accepts `content` (preferred) or `text` (alias). Live guide: /about/connect-your-bot',
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
    schemas: { Message, Conversation, AgentKey, Error },
  },
  tags: [
    { name: 'Chat', description: 'Conversations and messages' },
    { name: 'Agent keys', description: 'Mint / manage `oc_` API keys' },
    { name: 'Feedback', description: 'In-app feedback → WorldIssueTracker' },
    { name: 'Account', description: 'Current user' },
    { name: 'Meta', description: 'Health, spec' },
  ],
  paths: {
    '/health': {
      get: { tags: ['Meta'], summary: 'Health check', security: [], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/auth/me': {
      get: { tags: ['Account'], summary: 'Get the authenticated user', responses: { '200': ok({ type: 'object' }), '401': errResp('Unauthorized') } },
    },
    '/api/chat/conversations': {
      get: {
        tags: ['Chat'],
        summary: "List the caller's conversations",
        responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Conversation' } }), '401': errResp('Unauthorized') },
      },
      post: {
        tags: ['Chat'],
        summary: 'Create a conversation (direct or group)',
        description: 'For a self-DM, pass your own user id as the single participant.',
        requestBody: { required: true, content: json({ type: 'object', properties: { participantIds: { type: 'array', items: { type: 'string' } }, title: { type: 'string' }, type: { type: 'string', enum: ['direct', 'group'] } }, required: ['participantIds'] }) },
        responses: { '201': ok({ $ref: '#/components/schemas/Conversation' }, 'Created'), '400': errResp('Bad request'), '401': errResp('Unauthorized') },
      },
    },
    '/api/chat/conversations/{id}': {
      get: { tags: ['Chat'], summary: 'Get a conversation with participants', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ $ref: '#/components/schemas/Conversation' }), '404': errResp('Not found') } },
    },
    '/api/chat/conversations/{id}/messages': {
      get: {
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
        tags: ['Chat'],
        summary: 'Poll for new messages since a timestamp (across all conversations)',
        parameters: [{ name: 'since', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }],
        responses: { '200': ok({ type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } }), '401': errResp('Unauthorized') },
      },
    },
    '/api/chat/messages/{id}': {
      patch: { tags: ['Chat'], summary: 'Edit your message', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }) }, responses: { '200': ok({ $ref: '#/components/schemas/Message' }), '403': errResp('Not your message') } },
      delete: { tags: ['Chat'], summary: 'Delete your message (soft delete)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '403': errResp('Not your message') } },
    },
    '/api/chat/contacts': {
      get: { tags: ['Chat'], summary: 'List users (for starting conversations)', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: "Filter by name/email; 'self'/'me' matches the caller" }], responses: { '200': ok({ type: 'array', items: { type: 'object' } }) } },
    },
    '/api/chat/search': {
      get: { tags: ['Chat'], summary: 'Search messages', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/chat/presence': {
      put: { tags: ['Chat'], summary: 'Update your presence', requestBody: { required: true, content: json({ type: 'object', properties: { presenceStatus: { type: 'string' }, statusMessage: { type: 'string' } } }) }, responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/agent-keys': {
      get: { tags: ['Agent keys'], summary: 'List your agent keys (no plaintext)', responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/AgentKey' } }) } },
      post: { tags: ['Agent keys'], summary: 'Mint a new agent key', requestBody: { required: true, content: json({ type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] } }, expiresAt: { type: 'string', format: 'date-time' } }, required: ['name'] }) }, responses: { '201': ok({ allOf: [{ $ref: '#/components/schemas/AgentKey' }, { type: 'object', properties: { key: { type: 'string', description: 'plaintext, shown once' } } }] }, 'Created') } },
    },
    '/api/agent-keys/{id}/reveal': {
      get: { tags: ['Agent keys'], summary: 'Reveal the plaintext key (audit-logged)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object', properties: { key: { type: 'string' } } }) } },
    },
    '/api/agent-keys/{id}': {
      patch: { tags: ['Agent keys'], summary: 'Rename or change scopes', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } } }) }, responses: { '200': ok({ $ref: '#/components/schemas/AgentKey' }) } },
      delete: { tags: ['Agent keys'], summary: 'Revoke a key', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/feedback': {
      post: { tags: ['Feedback'], summary: 'Submit feedback → creates a WorldIssueTracker issue', requestBody: { required: true, content: json({ type: 'object', properties: { message: { type: 'string' }, context: { type: 'string' } }, required: ['message'] }) }, responses: { '201': ok({ type: 'object', properties: { url: { type: 'string' }, id: { type: 'string' } } }, 'Created'), '400': errResp('message required'), '503': errResp('Feedback not configured (WIT_AGENT_KEY unset)') } },
    },
  },
} as const;
