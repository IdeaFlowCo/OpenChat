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
| `oc_search_messages(query, limit?)` | Full-text search across messages, conversations, and contacts (`GET /api/chat/search`) |
| `oc_list_contacts(query?)` | List/filter contacts by name or email; `me`/`self` matches the caller (`GET /api/chat/contacts`) |
| `oc_create_conversation(participantIds, title?, type?)` | Create a direct or group conversation (`POST /api/chat/conversations`) |
| `oc_submit_feedback(message, context?)` | File feedback about OpenChat (`POST /api/feedback`) |
| `oc_react(messageId, emoji)` | Add an emoji reaction to a message |
| `oc_create_dm(userEmail)` | Look up a user by email and start/return a 1:1 DM conversation |
| `oc_register_agent(name, scopes?, expiresAt?)` | Mint a new agent API key under your account |

## How bi-directional access works

- **Outbound (agent → OpenChat):** any tool call (`oc_send_message`, `oc_react`, …) hits the OpenChat REST API as you. Messages appear in your conversations as if you sent them.
- **Inbound (OpenChat → agent):** call `oc_list_conversations` or `oc_get_messages` from inside your agent loop. New messages show up immediately because the underlying REST API reflects realtime state. The MCP server still polls; webhook-capable service bots should register `/api/webhooks` for push delivery.

This is **the same auth model as the OpenChat mobile/web app**, just exposed as MCP tools. There is no separate "bot mode" — your agent IS you.

## Security

- Keys are AES-256-GCM encrypted at rest on the server.
- Keys are re-viewable in-app (Settings → Agent keys → View full key) — you don't need to re-mint a new one if you lose it.
- Revoke any key from the same screen; revocations take effect within ~60 s (cache TTL).
- Restrict scope at creation time: `read` only, `write` only, or both.
