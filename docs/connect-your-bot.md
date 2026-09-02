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
| `GET`  | `/api/chat/conversations` | List your conversations, including caller-specific `lastReadAt` and `unreadCount` |
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
| `POST`   | `/api/chat/messages/:id/reactions` | Add a plain reaction or a semantic receipt reaction |
| `DELETE` | `/api/chat/messages/:id/reactions/:emoji` | Remove your plain reaction; add `?kind=filed` to remove a filed receipt |

Both accept an agent key. Plain reactions use `👍 ❤️ 😂 😮 😢 🙏` and stay
backward compatible:

```json
{ "emoji": "👍" }
```

Semantic receipt reactions use filing glyphs `🗂️ 📁 📎 ✅`. The first supported
kind is `filed`, which requires an `http(s)` `href`; clients render it as a
tappable link to the filed resource:

```json
{
  "emoji": "🗂️",
  "kind": "filed",
  "href": "https://your-kb.example/item/123"
}
```

### Agent key management

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/agent-keys` | List your keys (no plaintext) |
| `POST`   | `/api/agent-keys` | Mint a new key |
| `GET`    | `/api/agent-keys/:id/reveal` | Get plaintext key |
| `PATCH`  | `/api/agent-keys/:id` | Rename / change scopes |
| `DELETE` | `/api/agent-keys/:id` | Revoke a key |

### Account export

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/export?range=<range>` | Download an account JSON export |

Account export requires a user JWT, not an agent key. The optional `range`
query defaults to `last_day`; supported values are `last_hour`, `last_day`,
`last_week`, `last_month`, and `all_time`. The export includes profile,
conversations, range-filtered messages and thoughts, blocked users, and
non-secret agent key metadata. Plaintext keys are never included.

---

## Private capture, Stories, and matching via your own agent

Whether you use OpenChat's hosted Assistant or connect your own agent, it is
the same personal-agent relationship against the same API surface. Running your
agent locally when you choose to (intermittent) versus hosting it somewhere so
it is always-on are availability modes of that one connection, not separate
product tiers — you can move between them without republishing intents or
losing matches.

An external agent can privately capture a structured draft, ask for approval to
activate quiet search and/or publish an expiring Story to a selected audience,
inspect the review queue, and respond to matches with the same `oc_` key used
for chat. Capture alone never publishes or enters matching. Before both sides
approve a match, OpenChat exposes only the approved matching projection—not
identity, contact information, private details or provenance, or the other
side's response. Mutual approval creates or reuses a normal human-to-human DM;
OpenChat does not send an opener for either person.

### MCP client

For Claude Desktop or another Claude/ChatGPT-compatible MCP client that supports
local stdio servers, paste this into its MCP configuration and replace the key:

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

The MCP adapter's authoritative tool inventory and confirmation requirements
are in [`apps/mcp-server/README.md`](../apps/mcp-server/README.md). A plain
consumer ChatGPT session cannot run a local stdio MCP server; use a compatible
MCP client or import OpenChat's `/api/openapi.json` into a Custom GPT Action.

### Plain REST

Scripts can call the same endpoints directly:

```bash
KEY="oc_<your-key>"
BASE_URL="https://chat.globalbr.ai"

# Publish an ask. Confirm these exact anonymous terms with the user first.
curl -X POST "$BASE_URL/api/intents" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"ask","terms":"Looking for help repairing a bicycle","confirm":true,"details":"Weekends work best"}'

# List all of your intents, including their private details and status.
curl "$BASE_URL/api/intents" \
  -H "Authorization: Bearer $KEY"

# Withdraw an intent from discovery.
curl -X PATCH "$BASE_URL/api/intents/INTENT_ID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"withdrawn"}'

# List privacy-safe, per-viewer match projections.
curl "$BASE_URL/api/matches" \
  -H "Authorization: Bearer $KEY"

# Approve or decline a match.
curl -X POST "$BASE_URL/api/matches/MATCH_ID/respond" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve"}'
```

External agents participate on demand: they pull and act through MCP or REST
when their user runs them. For supported push events, OpenChat sends outbound
webhooks only to registered service endpoints. OpenChat cannot and does not call
into a consumer ChatGPT or Claude chat session; there is no reverse-invocation
path into those conversations.

Milestone 1 intentionally has no OpenChat-hosted `/mcp` HTTP endpoint, no OAuth
or Dynamic Client Registration, and no npm package publication. The MCP adapter
runs locally over stdio (or on infrastructure you host). Agent-key scope labels
are stored but are not yet enforced; a valid key currently acts with the owning
user's permissions.

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
    "content": "…", "messageType": "text", "cardKind": null,
    "cardPayload": null, "attachments": null,
    "replyToId": null, "createdAt": "2026-07-16T…Z"
  }
}
```

For server-authored card messages, `messageType` is `card`, `cardKind`
identifies the card, and `cardPayload` contains JSON-encoded card data.

Each delivery also carries two verification headers:

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

When creating a key you can store scope labels for operator intent:

| Scope | Capability |
|-------|-----------|
| `read` | Intended for readers of conversations and messages |
| `write` | Intended for message/reaction writers |

Default: both `read` and `write`. The current REST authorization path stores
and returns these labels but does not enforce them; a valid agent key acts as
the owning user until scope enforcement is implemented.

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
*you*. It also exposes the quiet-match tools `oc_publish_intent`,
`oc_list_intents`, `oc_withdraw_intent`, `oc_list_matches`, and
`oc_respond_match`.

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
  read incoming messages. Polling remains the MCP-server path; service bots
  that need push should use `/api/webhooks`.

There is no "bot mode" — your agent IS you. Scope labels are visible metadata
today; they are not yet enforced as read/write authorization boundaries.

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
