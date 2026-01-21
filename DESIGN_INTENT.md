# OpenChat Design Intent

## Overview

OpenChat is a GChat-inspired messaging application that integrates with the Noos knowledge graph backend. It provides real-time 1:1 chat with presence indicators and status messages.

## Architecture

### Backend (port 4001)
- **Express + Socket.io** for REST API and real-time messaging
- **Neo4j** graph database (same as Noos - production: `bolt://44.211.180.200:7687`)
- **JWT authentication** (shared secret with Noos for SSO)

### Frontend (port 5173 dev)
- **React + TypeScript + Vite**
- **TailwindCSS** for styling
- **Socket.io client** for real-time updates

## Current Features (Implemented)

### Authentication
- Dev login (`POST /api/auth/dev-login`) - email-based, creates user if needed
- Token login - paste existing Noos JWT
- SSO callback (`/auth/callback?token=...`) - receive token from Noos redirect
- Protected routes - redirect to login if not authenticated

### Contact Selection UI
**Location:** `client/src/components/ChatSidebar.tsx`

Flow:
1. User clicks "New" button in sidebar header
2. Contacts are loaded from API (`GET /api/chat/contacts`)
3. Contact picker UI slides in with:
   - Back button to return to conversation list
   - Search input for filtering by name/email (client-side)
   - Scrollable list of contacts with:
     - Avatar (first letter of name)
     - Presence indicator (green/yellow/red dot)
     - Name and status message
4. Clicking a contact:
   - Creates conversation via `POST /api/chat/conversations`
   - Sets it as active conversation
   - Returns to conversation view

### Contact Search (API - just implemented)
- `GET /api/chat/contacts?q=search` - filter by name/email substring (case-insensitive)
- `GET /api/chat/users/by-email/:email` - exact email lookup

### Conversations
- List conversations in sidebar with last message preview
- Create 1:1 conversations
- View conversation with participant info
- Real-time message delivery via WebSocket

### Messages
- Send/receive text messages
- Message list with sender info and timestamps
- Optimistic updates (send via socket, fallback to REST)

### Presence System
- Status options: available, away, busy, invisible, offline
- Custom status message
- Presence indicators on contacts and conversation list
- Real-time presence updates via WebSocket

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

(User)-[:PARTICIPATES_IN]->(Conversation)
(Message)-[:IN_CONVERSATION]->(Conversation)
(User)-[:SENT]->(Message)
```

## Pending Work

### OpenChat-es7: SSO Redirect Flow
Current login is standalone. Target flow:
1. User visits OpenChat without auth → redirect to Noos login
2. Noos authenticates → redirects back with token
3. OpenChat exchanges token for session

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
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Mark offline

### Chat
- `GET /api/chat/conversations` - List user's conversations
- `POST /api/chat/conversations` - Create conversation
- `GET /api/chat/conversations/:id` - Get with participants
- `GET /api/chat/conversations/:id/messages` - Paginated messages
- `POST /api/chat/conversations/:id/messages` - Send message
- `GET /api/chat/contacts` - List all users (supports ?q= search)
- `GET /api/chat/users/by-email/:email` - Direct email lookup
- `PUT /api/chat/presence` - Update own presence

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
4. **JWT sharing** - Same secret allows seamless SSO between apps
5. **Client-side contact filtering** - Simple, fast for small user counts; API search for larger scale
