# Connect your bot in 30 seconds

OpenChat supports agent API keys so any bot or script can read and send messages
using a standard `Authorization: Bearer` header — no JWT required.

---

## 30-second quickstart

1. Open the OpenChat app → **Settings** → **DEVELOPER** → **Agent keys**
2. Tap **+** → enter a name → tap **Create key**
3. Copy the key shown on screen (it is re-viewable any time from the key detail screen)
4. Use it in curl:

```bash
KEY="oc_<your-key>"
curl -H "Authorization: Bearer $KEY" \
  https://chat.globalbr.ai/api/chat/conversations
```

That's it. The key authenticates as you — same conversations, same permissions.

---

## API endpoints

All requests use:
```
Authorization: Bearer oc_<key>
```

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/chat/conversations` | List your conversations |
| `POST` | `/api/chat/conversations` | Create a new conversation |
| `GET`  | `/api/chat/conversations/:id` | Get conversation details |
| `GET`  | `/api/chat/conversations/:id/messages` | Get messages |
| `POST` | `/api/chat/conversations/:id/messages` | **Send a message** |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/chat/messages/since?since=<ISO>` | Fetch new messages since timestamp |
| `PATCH` | `/api/chat/messages/:id` | Edit your message |
| `DELETE` | `/api/chat/messages/:id` | Delete your message |

### Reactions

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/api/chat/messages/:id/reactions` | Add a reaction `{ "emoji": "🗂️" }` |
| `DELETE` | `/api/chat/messages/:id/reactions/:emoji` | Remove your reaction |

Both accept an agent key. The allowed emoji set is
`👍 ❤️ 😂 😮 😢 🙏 🗂️`. The `🗂️` glyph is the distinctive **"filed to KB"**
receipt a bot can drop on a message it has ingested — more expressive than a
plain WhatsApp reaction.

### Agent key management

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/agent-keys` | List your keys (no plaintext) |
| `POST`   | `/api/agent-keys` | Mint a new key |
| `GET`    | `/api/agent-keys/:id/reveal` | Get plaintext key |
| `PATCH`  | `/api/agent-keys/:id` | Rename / change scopes |
| `DELETE` | `/api/agent-keys/:id` | Revoke a key |

---

## Outbound webhooks (push instead of poll)

Rather than polling `GET /api/chat/messages/since`, register a webhook and
OpenChat will `POST` to your URL whenever a message lands in a conversation you
participate in.

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/api/webhooks` | Create a subscription (returns `secret` **once**) |
| `GET`    | `/api/webhooks` | List your subscriptions (no secret) |
| `DELETE` | `/api/webhooks/:id` | Delete a subscription |

Create body:

```json
{
  "url": "https://your-service.example/openchat/webhook",
  "events": ["message.created"],
  "conversationId": "optional — filter to one room; omit for all your rooms",
  "secret": "optional — supply your own shared secret; else one is minted"
}
```

Each delivery is a normalized message payload:

```json
{
  "event": "message.created",
  "message": {
    "id": "…", "conversationId": "…", "senderId": "…", "senderName": "…",
    "content": "…", "messageType": "text", "attachments": null,
    "replyToId": null, "createdAt": "2026-07-16T…Z"
  }
}
```

and carries two verification headers:

- `X-OpenChat-Secret: <your secret>` — raw shared secret (simple equality check).
- `X-OpenChat-Signature: sha256=<hex>` — HMAC-SHA256 of the exact request body,
  keyed by the secret (tamper-evident; recompute and compare).

Delivery is fire-and-forget with a 5 s timeout and a single retry; it never
blocks or delays the sender.

Webhook ownership depends on the credential used to create it. Webhooks created
with an agent key are bound to that key and are automatically deactivated when
the key is revoked, giving the operator a single kill switch. Webhooks created
with a user JWT are plain user-owned subscriptions and are managed with
`DELETE /api/webhooks/:id`.

---

## Credentials file convention

Agents and scripts should read credentials from:

```
~/.openchat/credentials.json
```

Set permissions to `0600` so only you can read it:

```bash
mkdir -p ~/.openchat
chmod 700 ~/.openchat
cat > ~/.openchat/credentials.json << 'EOF'
{
  "apiKey": "oc_<your-key>",
  "baseUrl": "https://chat.globalbr.ai"
}
EOF
chmod 600 ~/.openchat/credentials.json
```

Then in your script:

```python
import json, pathlib, urllib.request, urllib.error

creds = json.loads(pathlib.Path("~/.openchat/credentials.json").expanduser().read_text())
API_KEY = creds["apiKey"]
BASE_URL = creds["baseUrl"]

def get_conversations():
    req = urllib.request.Request(
        f"{BASE_URL}/api/chat/conversations",
        headers={"Authorization": f"Bearer {API_KEY}"}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())
```

---

## Scopes

When creating a key you can restrict what it can do:

| Scope | Capability |
|-------|-----------|
| `read` | Read conversations and messages |
| `write` | Send, edit, and delete messages |

Default: both `read` and `write`.

---

## Key security

- Keys are stored **encrypted at rest** (AES-256-GCM) in the OpenChat database.
- Keys are **re-viewable** — you can retrieve the plaintext any time from Settings → Agent keys → View full key. Each reveal is audit-logged.
- Revoked keys stop working **within 60 seconds** (the server caches auth decisions for up to 60 s).
- Keys do **not** expire by default. Pass `expiresAt` when creating a key to set an expiry.

---

## MCP server — full bi-directional access

The OpenChat MCP server lets Claude Desktop, Cursor, Codex CLI, Claude Code, and
any other MCP-aware client read AND write to your OpenChat conversations as
*you*. Tools available: `oc_list_conversations`, `oc_get_messages`,
`oc_send_message`, `oc_react`, `oc_create_dm`, `oc_register_agent`.

Source: <https://github.com/tmad4000/openchat-mcp-server>

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop — the OpenChat tools appear in the 🔌 menu.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "openchat": {
      "command": "npx",
      "args": ["-y", "github:tmad4000/openchat-mcp-server"],
      "env": { "OPENCHAT_API_KEY": "oc_your_key_here" }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.openchat]
command = "npx"
args = ["-y", "github:tmad4000/openchat-mcp-server"]
env = { OPENCHAT_API_KEY = "oc_your_key_here" }
```

### Claude Code

```bash
claude mcp add openchat \
  --env OPENCHAT_API_KEY=oc_your_key_here \
  -- npx -y github:tmad4000/openchat-mcp-server
```

### How bi-directional access works

- **Outbound:** every tool call hits the OpenChat REST API as you. Messages
  show up in conversations as if you sent them.
- **Inbound:** the agent calls `oc_list_conversations` / `oc_get_messages` to
  read incoming messages. Polling for now; WebSocket subscribe is on the
  roadmap.

There is no "bot mode" — your agent IS you, with the scopes you assigned to its
key. Limit blast radius with `read`-only keys for reader bots.

---

## Dedicated bot users (e.g. GroupBrain)

Most agents act *as their owning human* (the key authenticates as you). For a
first-class external bot that should appear as its own identity — its own name,
its own avatar, `isBot: true` — OpenChat provisions a dedicated bot **User**
distinct from the in-app `assistant` singleton.

The **GroupBrain** bot user (`id: "groupbrain"`) is created idempotently on
server boot by `ensureGroupbrainBotUser()`
(`apps/server/src/services/groupbrainBot.ts`), mirroring `ensureAssistantUser()`.
To wire groupbrain up:

1. The bot user exists automatically after a server start.
2. Mint an agent key (as the human operator) and hand it to groupbrain — or,
   to have messages appear *as GroupBrain*, mint the key while signed in as the
   `groupbrain` user so the key's owner is the bot.
3. Register an outbound webhook (above) so groupbrain receives `message.created`
   pushes, and reply / react via the REST endpoints.

GroupBrain's `isBot: true` marker is only its identity/UI marker. It is a
separate bot user and does not trigger the in-app assistant loop; that loop only
fires for the dedicated `assistant` singleton user.
