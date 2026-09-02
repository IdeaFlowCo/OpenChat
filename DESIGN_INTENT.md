# OpenChat Design Intent

## Overview

OpenChat is a GChat-inspired messaging application that integrates with the Noos knowledge graph backend. It provides real-time 1:1 chat with presence indicators and status messages.

## Architecture

### Backend (port 41851)
- **Express + Socket.io** for REST API and real-time messaging
- **Neo4j** graph database (same as Noos; production is self-hosted on GCP Compute Engine and configured through `NEO4J_URI`)
- **JWT authentication** (shared secret with Noos for SSO), `oc_` agent API keys for bot/script access, and a separate `OC_BRIDGE_SECRET` for the trusted SocialSphere → OpenChat identity bridge

### Frontend (port 29231 dev)
- **React + TypeScript + Vite**
- **TailwindCSS** for styling
- **Socket.io client** for real-time updates

## Current Features (Implemented)

### Authentication
- Dev login (`POST /api/auth/dev-login`) - email-based, creates user if needed
- Token login - paste existing Noos JWT
- SSO callback (`/auth/callback?code=...` or `#token=...`) - exchange with Noos
- Social identity bridge (`POST /api/auth/bridge-exchange`) - server-to-server verified-email assertion from `social.globalbr.ai`; creates/merges by email and can return an ordinary OpenChat JWT
- Protected routes - redirect to login if not authenticated

### Contact Selection UI
**Location:** `apps/web/src/components/ChatSidebar.tsx`

Flow:
1. User clicks "New" button in sidebar header
2. A person is found via exact email, or by partial name/email when the caller has server-granted trusted directory access (`GET /api/chat/contacts?q=...`)
3. Contact picker UI slides in with:
   - Back button to return to conversation list
   - Search input reflecting the caller's exact-email or trusted-directory access
   - Matching person rows with:
     - Avatar (first letter of name)
     - Presence indicator (green/yellow/red dot)
     - Name and status message
4. Clicking a contact:
   - Creates conversation via `POST /api/chat/conversations`
   - Sets it as active conversation
   - Returns to conversation view

### Contact Search (API)
- `GET /api/chat/contacts?q=email` - ordinary members use exact, case-insensitive email discovery and empty/self returns only the caller; server-granted trusted directory callers may browse and use partial name/email
- `GET /api/chat/users/by-email/:email` - exact, case-insensitive email lookup
- No browsable public account directory; a narrowly granted trusted-directory capability supports club operators while existing conversations and private invite/QR flows provide relationship-scoped discovery

### Conversations
- List conversations in sidebar with last message preview
- Create 1:1 conversations
- View conversation with participant info
- Real-time message delivery via WebSocket

### Messages
- Send/receive text messages
- Message list with sender info and timestamps
- Optimistic updates (send via socket, fallback to REST)
- Emoji reactions, including linked `filed` receipt reactions from bots

### Presence System
- Status options: available, away, busy, invisible, offline
- Custom status message
- Presence indicators on contacts and conversation list
- Real-time presence updates via WebSocket

### Agent and Bot Integrations
- Agent keys authenticate REST requests with `Authorization: Bearer oc_<key>`
- Outbound webhooks deliver `message.created` events to external services
- GroupBrain has a dedicated `groupbrain` bot user, distinct from the in-app `assistant`

## Data Model

### Neo4j Schema
```cypher
(:User {
  id, email, name,
  presenceStatus, statusMessage, lastSeenAt
})

(:Conversation {
  id, title, type: "direct"|"group",
  lastMessagePreview, lastMessageAt
})

(:Message {
  id, content, senderId, conversationId,
  messageType, createdAt
})

(:AgentKey {
  id, ownerUserId, name, keyPrefix, keyCiphertext,
  keyIv, scopes, createdAt, expiresAt, revokedAt
})

(:Webhook {
  id, ownerUserId, url, secret, events,
  conversationId, createdByKeyId, createdAt, deactivatedAt
})

(User)-[:PARTICIPATES_IN]->(Conversation)
(Message)-[:IN_CONVERSATION]->(Conversation)
(User)-[:SENT]->(Message)
(User)-[:REACTED {emoji, kind?, href?, createdAt}]->(Message)
(User)-[:OWNS_KEY]->(AgentKey)
(User)-[:OWNS_WEBHOOK]->(Webhook)
```

## Pending Work

### OpenChat-es7: SSO Redirect Flow
Current login is standalone. Target flow:
1. User visits OpenChat without auth → redirect to Noos login
2. Noos authenticates → redirects back with short-lived code
3. OpenChat exchanges code for session (no JWT in URL)

### Future: Group Chat
- Multi-user conversations
- Member management
- Unread counts

### Future: Knowledge Integration
- `@mentions` to reference/create Noos nodes
- `#hashtags` for labels
- `/note`, `/add` commands

## UI Component Structure

```
App.tsx
├── LoginPage (standalone login form)
├── SSOCallback (handles Noos redirect)
└── ChatPage (protected)
    ├── ChatSidebar
    │   ├── Header (user status, "New" button)
    │   ├── Contact Picker (when showContacts=true)
    │   │   ├── Search input
    │   │   └── Contact list with presence
    │   └── ConversationList (default view)
    └── Main content area
        ├── ConversationView (header, participants)
        ├── MessageList
        └── MessageInput
```

## API Endpoints

### Auth
- `POST /api/auth/dev-login` - { email, name? } → { token, user }
- `POST /api/auth/bridge-exchange` - trusted SocialSphere bridge; `Authorization: Bearer <OC_BRIDGE_SECRET>`, `{ app: "social", email, name?, avatarUrl?, ttl?, provisionOnly? }` → `{ token?, user }`
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Mark offline
- `GET /api/auth/login` - Redirect to Noos SSO authorize (code flow)

### Chat
- `GET /api/chat/conversations` - List user's conversations with caller-specific `lastReadAt` and `unreadCount`
- `GET /api/chat/unread-total` - JWT-authenticated aggregate unread count for badges
- `POST /api/chat/conversations` - Create conversation
- `GET /api/chat/conversations/:id` - Get with participants
- `GET /api/chat/conversations/:id/messages` - Paginated messages
- `POST /api/chat/conversations/:id/messages` - Send message
- `POST /api/chat/messages/:id/reactions` - Add a plain reaction or `filed` receipt reaction with `href` (JWT or agent key)
- `DELETE /api/chat/messages/:id/reactions/:emoji` - Remove own plain reaction; `?kind=filed` removes a filed receipt (JWT or agent key)
- `GET /api/chat/contacts` - Return self or an exact-email match for ordinary members; trusted directory callers may browse and search partial names/emails
- `GET /api/chat/users/by-email/:email` - Direct email lookup
- `PUT /api/chat/presence` - Update own presence

### Agent Keys
- `GET /api/agent-keys` - List caller's keys (no plaintext)
- `POST /api/agent-keys` - Mint a new key
- `GET /api/agent-keys/:id/reveal` - Reveal plaintext key
- `PATCH /api/agent-keys/:id` - Rename / change scopes
- `DELETE /api/agent-keys/:id` - Revoke key and deactivate webhooks created by it

### Webhooks
- `POST /api/webhooks` - Create outbound webhook subscription (returns secret once)
- `GET /api/webhooks` - List caller's subscriptions (no secret)
- `DELETE /api/webhooks/:id` - Delete subscription

### WebSocket Events
- `message:new` - Receive new message
- `message:send` - Send message
- `typing:start/stop` - Typing indicators
- `presence:updated` - Presence changes
- `conversation:join/leave` - Room management

## Design Decisions

1. **Separate from Noos codebase** - OpenChat is its own repo, imports Noos as dependency for auth
2. **Shared Neo4j database** - Chat nodes coexist with knowledge graph nodes
3. **Chat nodes don't inherit :Node** - Keeps chat immutable, knowledge editable
4. **JWT sharing** - Same secret allows seamless SSO between OpenChat and Noos
5. **Identity bridge separation** - SocialSphere uses `OC_BRIDGE_SECRET`, distinct from `JWT_SECRET`, to assert verified emails and receive normal OpenChat user JWTs; email verification stays upstream in SocialSphere
6. **Private contact discovery** - No public account directory; ordinary members require an exact complete email, QR code, or private group invite, while trusted directory access is granted only by operators
