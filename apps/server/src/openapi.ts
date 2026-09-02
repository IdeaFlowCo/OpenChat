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
    messageType: { type: 'string', enum: ['text', 'card'], default: 'text' },
    cardKind: { type: 'string', nullable: true, description: 'Card discriminator when messageType is card.' },
    cardPayload: { type: 'string', nullable: true, description: 'JSON-encoded card data when messageType is card.' },
    viaSecretary: { type: 'boolean', description: 'True when this is an owner-approved Secretary auto-reply.' },
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
    lastReadAt: { type: 'string', format: 'date-time', nullable: true },
    unreadCount: { type: 'integer', description: 'Caller-specific count of non-deleted messages from other senders after lastReadAt.' },
    participants: { type: 'array', items: { type: 'object' } },
  },
} as const;

const UnreadTotal = {
  type: 'object',
  properties: {
    unreadTotal: { type: 'integer', description: 'Caller-specific total unread count across visible conversations.' },
  },
  required: ['unreadTotal'],
} as const;

const AgentKey = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    keyPrefix: { type: 'string', example: 'oc_uzt9' },
    scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] } },
    agentName: { type: 'string', nullable: true },
    agentVersion: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    revokedAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const AgentIntent = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ownerUserId: { type: 'string', description: 'Returned only for the caller\'s own intents.' },
    kind: { type: 'string', enum: ['ask', 'offer'] },
    terms: { type: 'string', minLength: 1, maxLength: 500, description: 'Anonymous public matching terms.' },
    details: { type: 'string', nullable: true, maxLength: 2000, description: 'Private owner-only context; never shown to a match.' },
    status: { type: 'string', enum: ['active', 'paused', 'withdrawn', 'connected'] },
    expiresAt: { type: 'string', format: 'date-time', nullable: true, description: 'Optional discovery expiry. Expired intents are never matched.' },
    goal: { type: 'string', nullable: true, maxLength: 500 },
    seeks: { type: 'array', items: { type: 'string' }, description: 'Canonical resources/help sought. Legacy asks normalize to [terms].' },
    brings: { type: 'array', items: { type: 'string' }, description: 'Canonical resources/help brought. Legacy offers normalize to [terms].' },
    matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] },
    openToCollaborators: { type: 'boolean' },
    closeOnConnect: { type: 'boolean', description: 'Defaults true for legacy intents.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'ownerUserId', 'kind', 'terms', 'status', 'createdAt', 'updatedAt'],
} as const;

const AgentMatch = {
  type: 'object',
  description: 'Per-viewer anonymous match projection. The other user identity, private details, and response state are never returned.',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'awaiting_other', 'closed', 'connected'] },
    ownIntent: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['ask', 'offer'] },
        terms: { type: 'string' },
      },
      required: ['id', 'kind', 'terms'],
    },
    otherKind: { type: 'string', enum: ['ask', 'offer'] },
    otherTerms: { type: 'string' },
    matchType: { type: 'string', enum: ['complementary', 'reciprocal', 'shared_goal'] },
    score: { type: 'number', minimum: 0, maximum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    conversationId: { type: 'string', description: 'Present only after mutual approval.' },
    alreadyResolved: { type: 'boolean', description: 'True when responding to a match that was already closed or connected.' },
  },
  required: ['id', 'status', 'ownIntent', 'otherKind', 'otherTerms', 'createdAt', 'updatedAt'],
} as const;

const SocialAudience = {
  type: 'object',
  properties: {
    userIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
    conversationIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
  },
  required: ['userIds', 'conversationIds'],
} as const;

const IntentDraft = {
  type: 'object',
  description: 'Owner-only capture object. Drafts never enter matching or a human Story feed.',
  properties: {
    id: { type: 'string' }, ownerUserId: { type: 'string' }, goal: { type: 'string' },
    seeks: { type: 'array', items: { type: 'string' } },
    brings: { type: 'array', items: { type: 'string' } },
    matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] },
    openToCollaborators: { type: 'boolean' },
    details: { type: 'string', nullable: true, description: 'Private; never copied into Story/match projections.' },
    source: { type: 'string', nullable: true, description: 'Private capture source.' },
    provenance: { type: 'object', nullable: true, additionalProperties: true, description: 'Private capture provenance.' },
    confidence: { type: 'number', nullable: true, minimum: 0, maximum: 1 },
    state: { type: 'string', enum: ['pending', 'dismissed', 'activated'] },
    activatedIntentId: { type: 'string', nullable: true }, activatedStoryId: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'ownerUserId', 'goal', 'seeks', 'brings', 'matchingMode', 'openToCollaborators', 'state', 'createdAt', 'updatedAt'],
} as const;

const OwnedStory = {
  type: 'object',
  properties: {
    id: { type: 'string' }, ownerUserId: { type: 'string' }, goal: { type: 'string' },
    seeks: { type: 'array', items: { type: 'string' } }, brings: { type: 'array', items: { type: 'string' } },
    matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] },
    openToCollaborators: { type: 'boolean' }, text: { type: 'string', nullable: true },
    humanVisible: { type: 'boolean' }, agentSearchEnabled: { type: 'boolean' }, explicitQuietSearch: { type: 'boolean' },
    status: { type: 'string', enum: ['active', 'paused', 'withdrawn'] },
    audience: { $ref: '#/components/schemas/SocialAudience' },
    storyExpiresAt: { type: 'string', format: 'date-time', nullable: true },
    searchExpiresAt: { type: 'string', format: 'date-time' }, intentId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const FeedStory = {
  type: 'object',
  description: 'Agent-key projection of an audience-visible Story, including approved matching terms. Human JWT clients receive only id, author, text, expiry, and creation time.',
  properties: {
    id: { type: 'string' },
    author: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', nullable: true } }, required: ['id', 'name'] },
    goal: { type: 'string' }, seeks: { type: 'array', items: { type: 'string' } },
    brings: { type: 'array', items: { type: 'string' } },
    matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] },
    openToCollaborators: { type: 'boolean' }, text: { type: 'string' },
    storyExpiresAt: { type: 'string', format: 'date-time' }, createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const SocialPreferences = {
  type: 'object',
  properties: {
    experienceMode: { type: 'string', enum: ['enhanced', 'simple'], default: 'enhanced' },
    networkPaused: { type: 'boolean', default: false },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  required: ['experienceMode', 'networkPaused', 'updatedAt'],
} as const;

const SecretaryAnswer = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    question: { type: 'string', maxLength: 200 },
    answer: { type: 'string', maxLength: 2000 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'question', 'answer'],
} as const;

const SecretaryConfig = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    answers: { type: 'array', items: { $ref: '#/components/schemas/SecretaryAnswer' } },
  },
  required: ['enabled', 'answers'],
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
    secretary: { $ref: '#/components/schemas/SecretaryConfig' },
    intentDrafts: { type: 'array', items: { $ref: '#/components/schemas/IntentDraft' } },
    stories: { type: 'array', items: { $ref: '#/components/schemas/OwnedStory' } },
    intents: { type: 'array', items: { $ref: '#/components/schemas/AgentIntent' } },
    socialPreferences: { $ref: '#/components/schemas/SocialPreferences' },
    agentMatches: { type: 'array', items: { $ref: '#/components/schemas/AgentMatch' }, description: 'Privacy-safe per-viewer projections only; never includes the other owner identity or private fields.' },
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
        cardKind: { type: 'string', nullable: true },
        cardPayload: { type: 'string', nullable: true, description: 'JSON-encoded card data.' },
        attachments: { nullable: true },
        replyToId: { type: 'string', nullable: true },
        viaSecretary: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  },
} as const;

const BridgeExchangeRequest = {
  type: 'object',
  properties: {
    app: {
      type: 'string',
      enum: ['social'],
      description: 'Forensic caller marker. Only `social` is accepted.',
    },
    email: {
      type: 'string',
      format: 'email',
      description: 'Verified email asserted by social.globalbr.ai.',
    },
    name: { type: 'string' },
    avatarUrl: { type: 'string', format: 'uri' },
    ttl: {
      type: 'string',
      pattern: '^\\d+[smhd]$',
      default: '24h',
      description: 'JWT lifetime such as `30m`, `24h`, or `7d`; capped at seven days.',
    },
    provisionOnly: {
      type: 'boolean',
      default: false,
      description: 'When true, provisions/merges the user without returning a token.',
    },
  },
  required: ['app', 'email'],
} as const;

const BridgeExchangeResponse = {
  type: 'object',
  properties: {
    token: {
      type: 'string',
      description: 'OpenChat HS256 user JWT, omitted when provisionOnly is true.',
    },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string', format: 'email' },
        name: { type: 'string' },
      },
      required: ['id', 'email', 'name'],
    },
  },
  required: ['user'],
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
    version: '0.2.3',
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
    schemas: {
      Message,
      Conversation,
      AgentKey,
      AgentIntent,
      AgentMatch,
      SocialAudience,
      IntentDraft,
      OwnedStory,
      FeedStory,
      SocialPreferences,
      SecretaryAnswer,
      SecretaryConfig,
      AccountExport,
      ReactionSummary,
      Webhook,
      WebhookDelivery,
      BridgeExchangeRequest,
      BridgeExchangeResponse,
      Error,
    },
  },
  tags: [
    { name: 'Chat', description: 'Conversations and messages' },
    { name: 'Agent keys', description: 'Mint / manage `oc_` API keys' },
    { name: 'Agent network', description: 'Anonymous asks/offers and double-opt-in quiet matches' },
    { name: 'Agent social', description: 'Private capture, selected-audience Stories, preferences, and review' },
    { name: 'Webhooks', description: 'Outbound `message.created` subscriptions for bot channels' },
    { name: 'Feedback', description: 'In-app feedback → WorldIssueTracker' },
    { name: 'Secretary', description: 'Owner-approved direct-message auto-replies' },
    { name: 'Account', description: 'Current user' },
    { name: 'Identity bridge', description: 'Trusted first-party server-to-server user provisioning' },
    { name: 'Meta', description: 'Health, spec' },
  ],
  paths: {
    '/health': {
      get: { operationId: 'healthCheck', tags: ['Meta'], summary: 'Health check', security: [], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/auth/me': {
      get: { operationId: 'getMe', tags: ['Account'], summary: 'Get the authenticated user (or agent-key owner)', responses: { '200': ok({ type: 'object' }), '401': errResp('Unauthorized') } },
      delete: { operationId: 'deleteAccount', tags: ['Account'], summary: 'Delete the authenticated account and owned data', description: 'Atomically redacts authored messages; deletes account-owned drafts, Stories, intents, preferences, and match objects involving those intents; preserves unrelated users\' intent records; then deletes the user.', responses: { '204': { description: 'Deleted' }, '401': errResp('Unauthorized') } },
    },
    '/api/auth/export': {
      get: {
        operationId: 'exportAccount',
        tags: ['Account'],
        summary: 'Download an account data export',
        description: 'Requires a user JWT. The JSON bundle includes profile, conversations, range-filtered messages and thoughts, blocked users, and non-secret agent key metadata. Omit range to export the last day.',
        parameters: [
          { name: 'range', in: 'query', required: false, schema: { type: 'string', default: 'last_day', enum: ['last_hour', 'last_day', 'last_week', 'last_month', 'all_time'] }, description: 'Optional export window; defaults to last_day.' },
        ],
        responses: { '200': ok({ $ref: '#/components/schemas/AccountExport' }), '400': errResp('Invalid range'), '401': errResp('Unauthorized') },
      },
    },
    '/api/auth/bridge-exchange': {
      post: {
        operationId: 'bridgeExchange',
        tags: ['Identity bridge'],
        summary: 'Provision a social user and optionally mint an OpenChat JWT',
        security: bearer,
        description: 'Server-to-server endpoint for the trusted social.globalbr.ai peer. Authenticate with `Authorization: Bearer <OC_BRIDGE_SECRET>`, not a user JWT or `oc_` key. The peer must verify the email before calling OpenChat; OpenChat merges users by email, sets `signupProvider: "social-bridge"` only on creation, and does not send messages or trigger webhook/assistant/push side effects.',
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/BridgeExchangeRequest' }) },
        responses: {
          '201': ok({ $ref: '#/components/schemas/BridgeExchangeResponse' }, 'Created'),
          '400': errResp('Bad request'),
          '401': errResp('Invalid bridge credentials'),
          '503': errResp('Identity bridge is not configured'),
        },
      },
    },
    '/api/intents': {
      get: {
        operationId: 'listIntents',
        tags: ['Agent network'],
        summary: "List the caller's asks and offers",
        responses: { '200': ok({ type: 'object', properties: { intents: { type: 'array', items: { $ref: '#/components/schemas/AgentIntent' } } } }), '401': errResp('Unauthorized') },
      },
      post: {
        operationId: 'publishIntent',
        tags: ['Agent network'],
        summary: 'Publish an anonymous ask or offer',
        description: 'Publishing is explicit discovery opt-in. Only terms and kind are visible to a potential match; details remain private.',
        requestBody: { required: true, content: json({ type: 'object', properties: { kind: { type: 'string', enum: ['ask', 'offer'] }, terms: { type: 'string', minLength: 1, maxLength: 500 }, details: { type: 'string', maxLength: 2000 }, expiresAt: { type: 'string', format: 'date-time', description: 'Optional future discovery expiry.' }, goal: { type: 'string', maxLength: 500 }, seeks: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } }, brings: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } }, matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] }, openToCollaborators: { type: 'boolean' }, audience: { $ref: '#/components/schemas/SocialAudience' }, closeOnConnect: { type: 'boolean' } }, required: ['kind', 'terms'] }) },
        responses: { '201': ok({ type: 'object', properties: { intent: { $ref: '#/components/schemas/AgentIntent' } } }, 'Created'), '400': errResp('Bad request'), '401': errResp('Unauthorized') },
      },
    },
    '/api/intents/{id}': {
      patch: {
        operationId: 'withdrawIntent',
        tags: ['Agent network'],
        summary: 'Withdraw an intent from discovery',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json({ type: 'object', properties: { status: { type: 'string', const: 'withdrawn' } }, required: ['status'] }) },
        responses: { '200': ok({ type: 'object', properties: { intent: { $ref: '#/components/schemas/AgentIntent' } } }), '400': errResp('Bad request'), '404': errResp('Not found') },
      },
    },
    '/api/matches': {
      get: {
        operationId: 'listMatches',
        tags: ['Agent network'],
        summary: "List the caller's anonymous quiet matches",
        responses: { '200': ok({ type: 'object', properties: { matches: { type: 'array', items: { $ref: '#/components/schemas/AgentMatch' } } } }), '401': errResp('Unauthorized') },
      },
    },
    '/api/matches/{id}/respond': {
      post: {
        operationId: 'respondMatch',
        tags: ['Agent network'],
        summary: 'Approve or decline a quiet match',
        description: 'Responses are idempotent. Mutual approval creates or reuses a human DM with one neutral context card and sends no opener.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json({ type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'decline'] } }, required: ['decision'] }) },
        responses: { '200': ok({ type: 'object', properties: { match: { $ref: '#/components/schemas/AgentMatch' } } }), '400': errResp('Bad request'), '404': errResp('Not found') },
      },
    },
    '/api/intent-drafts': {
      get: {
        operationId: 'listIntentDrafts', tags: ['Agent social'], summary: 'List private intent drafts owned by the caller',
        responses: { '200': ok({ type: 'object', properties: { drafts: { type: 'array', items: { $ref: '#/components/schemas/IntentDraft' } } } }), '401': errResp('Unauthorized') },
      },
      post: {
        operationId: 'createIntentDraft', tags: ['Agent social'], summary: 'Capture a private structured draft',
        description: 'Private-by-default: creating a draft does not publish it, make it matchable, or place it in a human feed.',
        requestBody: { required: true, content: json({ type: 'object', properties: {
          goal: { type: 'string', maxLength: 500 }, seeks: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
          brings: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
          matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] }, openToCollaborators: { type: 'boolean' },
          details: { type: 'string', maxLength: 4000 }, source: { type: 'string', maxLength: 1000 },
          provenance: { type: 'object', additionalProperties: true }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        }, description: 'At least one non-empty goal, seek, or bring is required.' }) },
        responses: { '201': ok({ type: 'object', properties: { draft: { $ref: '#/components/schemas/IntentDraft' } } }, 'Created'), '400': errResp('Bad request') },
      },
    },
    '/api/intent-drafts/{id}': {
      patch: {
        operationId: 'updateIntentDraft', tags: ['Agent social'], summary: 'Edit or dismiss a private pending draft',
        description: 'The merged pending draft must retain a non-empty goal, seek, or bring. state may only be set to dismissed.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json({ type: 'object', additionalProperties: true }) },
        responses: { '200': ok({ type: 'object', properties: { draft: { $ref: '#/components/schemas/IntentDraft' } } }), '400': errResp('Bad request'), '404': errResp('Not found') },
      },
    },
    '/api/intent-drafts/{id}/activate': {
      post: {
        operationId: 'activateIntentDraft', tags: ['Agent social'], summary: 'Explicitly activate a private draft',
        description: 'Enable quietSearch, a human Story, or both. Human Stories require a non-empty selected audience. Defaults: quiet search 30 days; Story 24 hours. A Story-only activation limits structured discovery to the same audience and Story expiry.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json({ type: 'object', properties: {
          quietSearch: { type: 'object', properties: { enabled: { type: 'boolean' }, expiresAt: { type: 'string', format: 'date-time' }, audience: { $ref: '#/components/schemas/SocialAudience' } }, required: ['enabled'] },
          story: { type: 'object', properties: { enabled: { type: 'boolean' }, text: { type: 'string', maxLength: 2000 }, expiresAt: { type: 'string', format: 'date-time' }, audience: { $ref: '#/components/schemas/SocialAudience' } }, required: ['enabled', 'text', 'audience'] },
          closeOnConnect: { type: 'boolean', default: true },
        } }) },
        responses: { '201': ok({ type: 'object', properties: { draft: { $ref: '#/components/schemas/IntentDraft' }, story: { $ref: '#/components/schemas/OwnedStory' }, intent: { $ref: '#/components/schemas/AgentIntent' } } }, 'Activated'), '400': errResp('Bad request'), '404': errResp('Not found') },
      },
    },
    '/api/stories/feed': {
      get: { operationId: 'listStoryFeed', tags: ['Agent social'], summary: 'List currently visible human Stories', description: 'Enforces selected audience, current conversation membership, bidirectional blocks, status, and expiry. Agent-only objects are never returned.', responses: { '200': ok({ type: 'object', properties: { stories: { type: 'array', items: { $ref: '#/components/schemas/FeedStory' } } } }) } },
    },
    '/api/stories/mine': {
      get: { operationId: 'listOwnedStories', tags: ['Agent social'], summary: 'List the caller\'s Story and agent-only records', responses: { '200': ok({ type: 'object', properties: { stories: { type: 'array', items: { $ref: '#/components/schemas/OwnedStory' } } } }) } },
    },
    '/api/stories': {
      post: {
        operationId: 'createStory', tags: ['Agent social'], summary: 'Explicitly publish a selected-audience human Story',
        description: 'Text alone is sufficient. Structured terms are optional. Without separately enabled quietSearch, the audience-scoped structured intent expires with the Story.',
        requestBody: { required: true, content: json({ type: 'object', properties: {
          text: { type: 'string', minLength: 1, maxLength: 2000 }, audience: { $ref: '#/components/schemas/SocialAudience' },
          goal: { type: 'string', maxLength: 500 }, seeks: { type: 'array', items: { type: 'string' } }, brings: { type: 'array', items: { type: 'string' } },
          matchingMode: { type: 'string', enum: ['fulfillment', 'reciprocal', 'shared_goal'] }, openToCollaborators: { type: 'boolean' },
          storyExpiresAt: { type: 'string', format: 'date-time' },
          quietSearch: { type: 'object', properties: { enabled: { type: 'boolean' }, expiresAt: { type: 'string', format: 'date-time' }, audience: { $ref: '#/components/schemas/SocialAudience' } }, required: ['enabled'] },
          closeOnConnect: { type: 'boolean', default: true },
        }, required: ['text', 'audience'] }) },
        responses: { '201': ok({ type: 'object', properties: { story: { $ref: '#/components/schemas/OwnedStory' }, intent: { $ref: '#/components/schemas/AgentIntent' } } }, 'Created'), '400': errResp('Bad request') },
      },
    },
    '/api/stories/{id}': {
      patch: { operationId: 'updateStory', tags: ['Agent social'], summary: 'Pause, resume, withdraw, or extend an owned Story', description: 'At least one field is required. A separately approved quiet search retains its own state and expiry across human Story changes. Without separate quiet-search approval, pause/resume mirrors the linked audience-scoped intent and expiry extensions stay synchronized.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { status: { type: 'string', enum: ['active', 'paused', 'withdrawn'] }, storyExpiresAt: { type: 'string', format: 'date-time' } } }) }, responses: { '200': ok({ type: 'object', properties: { story: { $ref: '#/components/schemas/OwnedStory' } } }), '400': errResp('Bad request'), '404': errResp('Not found') } },
    },
    '/api/stories/{id}/respond': {
      post: { operationId: 'respondToStory', tags: ['Agent social'], summary: 'Reply to a currently visible Story in a normal DM', description: 'Authorization is rechecked against current audience, membership, blocks, status, and expiry before sending.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['message'] }) }, responses: { '201': ok({ type: 'object', properties: { conversationId: { type: 'string' }, message: { $ref: '#/components/schemas/Message' } } }, 'Sent'), '404': errResp('Visible Story not found') } },
    },
    '/api/social/preferences': {
      get: { operationId: 'getSocialPreferences', tags: ['Agent social'], summary: 'Get presentation mode and independent network pause', responses: { '200': ok({ $ref: '#/components/schemas/SocialPreferences' }) } },
      patch: { operationId: 'updateSocialPreferences', tags: ['Agent social'], summary: 'Update presentation mode and/or independent network pause', description: 'Simple mode does not delete or pause active data. networkPaused independently prevents new matches.', requestBody: { required: true, content: json({ type: 'object', properties: { experienceMode: { type: 'string', enum: ['enhanced', 'simple'] }, networkPaused: { type: 'boolean' } } }) }, responses: { '200': ok({ $ref: '#/components/schemas/SocialPreferences' }) } },
    },
    '/api/review': {
      get: { operationId: 'getSocialReviewQueue', tags: ['Agent social'], summary: 'Get the bounded actionable review queue', description: 'Returns at most 50 pending drafts, unanswered matches, and searches/Stories expiring within 72 hours. It is a computed projection, not the raw inference backlog.', responses: { '200': ok({ type: 'object', properties: { items: { type: 'array', maxItems: 50, items: { type: 'object' } }, hasMore: { type: 'boolean' } }, required: ['items', 'hasMore'] }) } },
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
    '/api/chat/unread-total': {
      get: {
        operationId: 'getUnreadTotal',
        tags: ['Chat'],
        summary: "Get the caller's aggregate unread count",
        description: 'JWT-authenticated navbar badge endpoint. Counts non-deleted messages from other senders after each visible conversation PARTICIPATES_IN.lastReadAt, defaulting missing lastReadAt to the epoch.',
        responses: { '200': ok(UnreadTotal), '401': errResp('Unauthorized') },
      },
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
        requestBody: { required: true, content: json({ type: 'object', properties: { content: { type: 'string' }, text: { type: 'string', description: 'alias for content' }, messageType: { type: 'string', enum: ['text'], default: 'text', description: 'Client-authored messages are text only; cards are server-internal.' } } }) },
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
      get: { operationId: 'listContacts', tags: ['Chat'], summary: 'Find a user for starting a conversation', description: 'Ordinary members get only themselves for an empty/self query and need a complete, case-insensitive exact email for another person. Callers with server-granted trusted directory access may browse and use partial name/email queries.', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: "Complete email address or 'self'/'me'/'myself'; trusted directory callers may also use a partial name/email or omit the query to browse" }], responses: { '200': ok({ type: 'array', items: { type: 'object' } }) } },
    },
    '/api/chat/search': {
      get: { operationId: 'searchMessages', tags: ['Chat'], summary: 'Search messages and conversations', description: 'Contact results require self keywords or a complete exact email for ordinary members; callers with server-granted trusted directory access may use partial name/email queries.', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/chat/presence': {
      put: { operationId: 'updatePresence', tags: ['Chat'], summary: 'Update your presence', requestBody: { required: true, content: json({ type: 'object', properties: { presenceStatus: { type: 'string' }, statusMessage: { type: 'string' } } }) }, responses: { '200': ok({ type: 'object' }) } },
    },
    '/api/secretary': {
      get: { operationId: 'getSecretary', tags: ['Secretary'], summary: 'Get Secretary mode and approved quick answers', responses: { '200': ok({ $ref: '#/components/schemas/SecretaryConfig' }), '401': errResp('Unauthorized') } },
      patch: { operationId: 'setSecretaryEnabled', tags: ['Secretary'], summary: 'Enable or disable Secretary mode', requestBody: { required: true, content: json({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }) }, responses: { '200': ok({ type: 'object', properties: { enabled: { type: 'boolean' } } }), '400': errResp('Bad request') } },
    },
    '/api/secretary/answers': {
      post: { operationId: 'createSecretaryAnswer', tags: ['Secretary'], summary: 'Add an approved quick answer', requestBody: { required: true, content: json({ type: 'object', properties: { question: { type: 'string', maxLength: 200 }, answer: { type: 'string', maxLength: 2000 } }, required: ['question', 'answer'] }) }, responses: { '201': ok({ $ref: '#/components/schemas/SecretaryAnswer' }, 'Created'), '400': errResp('Bad request') } },
    },
    '/api/secretary/answers/{id}': {
      patch: { operationId: 'updateSecretaryAnswer', tags: ['Secretary'], summary: 'Update an approved quick answer', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: json({ type: 'object', properties: { question: { type: 'string', maxLength: 200 }, answer: { type: 'string', maxLength: 2000 } }, required: ['question', 'answer'] }) }, responses: { '200': ok({ $ref: '#/components/schemas/SecretaryAnswer' }), '404': errResp('Not found') } },
      delete: { operationId: 'deleteSecretaryAnswer', tags: ['Secretary'], summary: 'Delete an approved quick answer', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': ok({ type: 'object' }), '404': errResp('Not found') } },
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
