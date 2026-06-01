# OpenChat MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) adapter for [OpenChat](https://chat.globalbr.ai). Lets any MCP-aware client (Claude Desktop, Cursor, Cline, etc.) read conversations, send messages, react, and create DMs — all with a single config snippet.

## Install

```bash
# Once published to npm:
npx -y @openchat/mcp-server

# Local install (from this repo):
npm install && npm run build
npm install -g .
```

## Authentication

You need an OpenChat API key (starts with `oc_`). Get one in **Settings → Agent Keys** in OpenChat.

Set it as an environment variable:
```bash
export OPENCHAT_API_KEY="oc_your_key_here"
```

Or create a credentials file at `~/.openchat/credentials.json`:
```json
{
  "apiKey": "oc_your_key_here",
  "baseUrl": "https://chat.globalbr.ai"
}
```

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openchat": {
      "command": "npx",
      "args": ["-y", "@openchat/mcp-server"],
      "env": {
        "OPENCHAT_API_KEY": "oc_your_key_here"
      }
    }
  }
}
```

If installed locally (`npm install -g .`):

```json
{
  "mcpServers": {
    "openchat": {
      "command": "openchat-mcp-server",
      "env": {
        "OPENCHAT_API_KEY": "oc_your_key_here"
      }
    }
  }
}
```

## Cursor

In `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "openchat": {
      "command": "npx",
      "args": ["-y", "@openchat/mcp-server"],
      "env": {
        "OPENCHAT_API_KEY": "oc_your_key_here"
      }
    }
  }
}
```

For the HTTP transport (useful for hosted deployments):

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

Start the HTTP server with:
```bash
OPENCHAT_API_KEY=oc_... node dist/http.js
# or
npm run start:http
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCHAT_API_KEY` | — | Bearer token (`oc_…` agent key or JWT). Falls back to `~/.openchat/credentials.json`. |
| `OPENCHAT_BASE_URL` | `https://chat.globalbr.ai` | OpenChat server URL. Falls back to `credentials.json`. |
| `PORT` | `8484` | HTTP server port (HTTP transport only) |
| `HOST` | `0.0.0.0` | HTTP server bind address (HTTP transport only) |

## Tools

| Tool | Description |
|---|---|
| `oc_list_conversations` | List all your conversations (id, title, type, last message preview) |
| `oc_get_messages(conversationId, limit?)` | Read recent messages from a conversation |
| `oc_send_message(conversationId, text)` | Send a message to a conversation |
| `oc_react(messageId, emoji)` | Add an emoji reaction to a message |
| `oc_create_dm(userEmail)` | Look up a user by email and start/return a 1:1 DM conversation |
| `oc_register_agent(name, scopes?, expiresAt?)` | Mint a new agent API key under your account |

> **Note on `oc_register_agent`:** This depends on the `/api/agent-keys` server endpoint (OpenChat-7c9). Until that ships, the tool returns a clear message explaining how to create a key manually in Settings.

## Build from source

```bash
npm install
npm run build        # produces dist/
npm start            # stdio (Claude Desktop)
npm run start:http   # HTTP transport (Cursor / hosted)
```
