# OpenChat MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) adapter for [OpenChat](https://chat.globalbr.ai). Lets any MCP-aware client (Claude Desktop, Cursor, Cline, Codex CLI, …) read conversations, send messages, react, and create DMs — all with a single JSON config snippet.

**Bi-directional out of the box:** your agent can read incoming messages AND send replies. Same identity as you — same conversations, same permissions.

## 30-second setup

1. Open OpenChat → **Settings → Agent keys → +** → name it → **Create key**
2. Copy the key (starts with `oc_`)
3. Paste one of the snippets below into your MCP client's config

That's it. No npm install, no clone — the `npx github:…` form below builds and runs the server on first launch.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "openchat": {
      "command": "npx",
      "args": ["-y", "github:tmad4000/openchat-mcp-server"],
      "env": {
        "OPENCHAT_API_KEY": "oc_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see the OpenChat tools appear in the 🔌 menu.

## Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-scoped):

```json
{
  "mcpServers": {
    "openchat": {
      "command": "npx",
      "args": ["-y", "github:tmad4000/openchat-mcp-server"],
      "env": {
        "OPENCHAT_API_KEY": "oc_your_key_here"
      }
    }
  }
}
```

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.openchat]
command = "npx"
args = ["-y", "github:tmad4000/openchat-mcp-server"]
env = { OPENCHAT_API_KEY = "oc_your_key_here" }
```

## Claude Code

Add at the project or user level:

```bash
claude mcp add openchat \
  --env OPENCHAT_API_KEY=oc_your_key_here \
  -- npx -y github:tmad4000/openchat-mcp-server
```

## HTTP transport (for hosted deployments)

Some clients prefer HTTP over stdio. Run the server yourself:

```bash
OPENCHAT_API_KEY=oc_... npx -y github:tmad4000/openchat-mcp-server openchat-mcp-server-http
# or after cloning: npm run start:http
```

Then point your client at it:

```json
{
  "mcpServers": {
    "openchat": {
      "url": "http://localhost:8484/mcp",
      "headers": {
        "Authorization": "Bearer oc_your_key_here"
      }
    }
  }
}
```

## Local clone (for development)

```bash
git clone https://github.com/tmad4000/openchat-mcp-server
cd openchat-mcp-server
npm install && npm run build
OPENCHAT_API_KEY=oc_... npm start         # stdio
OPENCHAT_API_KEY=oc_... npm run start:http # HTTP transport
```

## Authentication

Set the API key one of three ways (checked in this order):

1. `OPENCHAT_API_KEY` environment variable
2. `~/.openchat/credentials.json`:
   ```json
   { "apiKey": "oc_your_key_here", "baseUrl": "https://chat.globalbr.ai" }
   ```
3. The MCP server will fail with a clear error if none is set.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCHAT_API_KEY` | — | Bearer token (`oc_…` agent key or JWT). Falls back to `~/.openchat/credentials.json`. |
| `OPENCHAT_BASE_URL` | `https://chat.globalbr.ai` | OpenChat server URL. |
| `PORT` | `8484` | HTTP server port (HTTP transport only) |
| `HOST` | `0.0.0.0` | HTTP server bind address (HTTP transport only) |

## Tools

| Tool | Description |
|---|---|
| `oc_list_conversations` | List all your conversations (id, title, type, last message preview) |
| `oc_get_messages(conversationId, limit?)` | Read recent messages from a conversation |
| `oc_send_message(conversationId, text)` | Send a message to a conversation |
| `oc_search_messages(query, limit?)` | Search messages and conversations; contact results use exact email/self for ordinary members and partial name/email for trusted directory callers (`GET /api/chat/search`) |
| `oc_list_contacts(query?)` | Ordinary members use complete email or self; server-granted trusted directory callers may browse and use partial name/email (`GET /api/chat/contacts`) |
| `oc_create_conversation(participantIds, title?, type?)` | Create a direct or group conversation (`POST /api/chat/conversations`) |
| `oc_submit_feedback(message, context?)` | File feedback about OpenChat (`POST /api/feedback`) |
| `oc_react(messageId, emoji, kind?, href?)` | Add an emoji reaction; pass `kind="filed"` with an `http(s)` `href` to leave a tappable filed-receipt badge |
| `oc_create_dm(userEmail)` | Look up a user by email and start/return a 1:1 DM conversation |
| `oc_register_agent(name, scopes?, expiresAt?)` | Mint a new agent API key under your account |
| `oc_publish_intent(kind, terms, details?, expiresAt?)` | Publish an anonymous ask or offer for quiet matching (`POST /api/intents`) |
| `oc_list_intents` | List all asks and offers you own (`GET /api/intents`) |
| `oc_withdraw_intent(intentId)` | Withdraw one of your intents from discovery (`PATCH /api/intents/:id`) |
| `oc_list_matches` | List privacy-safe matches involving your intents (`GET /api/matches`) |
| `oc_respond_match(matchId, decision)` | Approve or decline a match (`POST /api/matches/:id/respond`) |
| `oc_create_intent_draft(goal?, seeks?, brings?, …)` | Privately capture an ask, offer, or collaboration; never publishes or matches |
| `oc_list_intent_drafts` | List owner-only pending/dismissed/activated drafts |
| `oc_update_intent_draft(draftId, …)` | Edit or dismiss a pending private draft |
| `oc_activate_intent_draft(draftId, confirm, quietSearch?, story?)` | Explicitly activate quiet search and/or a selected-audience Story |
| `oc_list_stories` | List your human-visible and agent-only Story objects and separate expiries |
| `oc_list_story_feed` | List only the redacted, currently authorized human Story feed |
| `oc_publish_story(confirm, text, audience, …)` | Explicitly publish a human Story to selected users/conversations |
| `oc_update_story(storyId, status?, storyExpiresAt?)` | Pause/resume/withdraw or extend a Story without silently extending separate search |
| `oc_withdraw_story(storyId)` | Withdraw a Story; separately approved quiet search may continue |
| `oc_respond_story(storyId, message, confirm)` | Preview, explicitly confirm, then send a Story reply in a normal OpenChat DM |
| `oc_get_social_preferences` | Read enhanced/simple presentation mode and independent network pause |
| `oc_update_social_preferences(experienceMode?, networkPaused?)` | Update social preferences without deleting data |
| `oc_get_review_queue` | Get at most 50 actionable drafts, matches, and expiring items |

Draft creation is always private. Agents may attach structured `provenance` to a draft so evidence references survive capture; it remains owner-only and is excluded from draft cards, Stories, matches, notifications, and viewer payloads. Before activation or Story publication, an agent must preview the exact discoverable terms, human text, audience, and expiries and receive explicit user approval (`confirm: true`). Story responses also require an exact message-and-context preview before `confirm: true`. Human Stories default to 24 hours. Explicit quiet searches default to 30 days. A Story without a separately enabled quiet search limits its structured agent visibility to the Story audience and expiry. Match proposals remain anonymous and require both people to approve before OpenChat creates one DM with one context card; no opener is sent.

## How bi-directional access works

- **Outbound (agent → OpenChat):** any tool call (`oc_send_message`, `oc_react`, …) hits the OpenChat REST API as you. Messages appear in your conversations as if you sent them.
- **Filed receipts:** `oc_react(messageId, "🗂️", "filed", "https://...")` records a bot filing receipt; web and mobile render it as a link to the filed resource.
- **Inbound (OpenChat → agent):** call `oc_list_conversations` or `oc_get_messages` from inside your agent loop. New messages show up immediately because the underlying REST API reflects realtime state. The MCP server still polls; webhook-capable service bots should register `/api/webhooks` for push delivery.

This is **the same auth model as the OpenChat mobile/web app**, just exposed as MCP tools. There is no separate "bot mode" — your agent IS you.

## Security

- Keys are AES-256-GCM encrypted at rest on the server.
- Keys are re-viewable in-app (Settings → Agent keys → View full key) — you don't need to re-mint a new one if you lose it.
- Revoke any key from the same screen; revocations take effect within ~60 s (cache TTL).
- Scope labels (`read`, `write`, or both) are stored and returned for operator intent. Current server authorization does not enforce those labels; a valid key acts as the owning user.
