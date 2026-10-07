# Agent setup · OpenChat + Unlinked

One Ideaflow account connects your conversations and professional network.
Start here for API keys, MCP, agent instructions, and troubleshooting.

| What you need | Connection | Docs |
|---|---|---|
| OpenChat messages and conversation context | One OpenChat API key (`oc_…`) for both REST and MCP | [API reference](/api/docs) · [OpenAPI](/api/openapi.json) · [Agent brief](/AGENTS.md) |
| Unlinked people and network search | Sign in through Unlinked MCP, or use its account grant | [Unlinked agent setup](https://www.unlinked.ai/agents) · [Agent brief](https://www.unlinked.ai/AGENTS.md) · [API schema](https://www.unlinked.ai/openapi.json) |

The apps share your Ideaflow identity and inbox. Their agent credentials are
currently separate: an OpenChat key works for OpenChat messages **and Context**;
it is not an Unlinked grant. Unlinked grants do not send OpenChat messages.

## Get a fresh OpenChat API key

Open [OpenChat](/app/) → **Settings → Agent keys → New API key**. Name the key
for the agent (for example, Hermes), then choose **Create key**. Read and write
access lets it read conversations and post messages or context as you.

**Copy agent setup** in Settings creates a new read/write key every time and
copies instructions for an agent that can make HTTPS requests. Existing keys
keep working until revoked or expired. Open an existing key to use **Copy API key**, **Copy setup with this key**,
**View full key**, or **Copy curl snippet** repeatedly. These reuse that key;
only New API key and the Settings quick setup create a new one. A new key is not required for Context.

Key management requires your signed-in user session; an agent key cannot mint
or revoke other keys.

## Connect and verify

For Hermes or another agent with HTTP tools, paste **Copy agent setup** into it.
First make this read-only call with your key:

```bash
curl -H "Authorization: Bearer $OPENCHAT_API_KEY" \
  https://chat.ideaflow.app/api/chat/conversations
```

The response is a **JSON array**, not `{ "conversations": [...] }`.
Each item has `id`, `type`, `title` (which may be null), `lastMessagePreview`,
and `participants: [{ "role": "member", "user": { "id": "…", "name": "…" } }]`.
Use `participants[].user.name` to identify a DM. If names repeat, use the ID and
recent message preview to select the intended conversation.

For OpenChat MCP, use the maintained [MCP adapter and client configurations](https://github.com/IdeaFlowCo/OpenChat/tree/main/apps/mcp-server).
It runs locally over stdio; there is no live OpenChat-hosted `/mcp` connector.
Use the same API key as REST and set `OPENCHAT_BASE_URL=https://chat.ideaflow.app`.
The old standalone repository and unpublished npm package are not setup paths.

For Unlinked MCP, use **https://www.unlinked.ai/mcp** and sign in, or copy the
account-grant configuration from [Unlinked Settings](https://www.unlinked.ai/settings).
Verify with `unlinked_whoami` or a real search; a downloaded configuration alone
does not prove that the connection works. Its [setup guide](https://www.unlinked.ai/agents)
contains the client-specific instructions and links to all discovery documents.

## OpenAI dots and ChatGPT

Dots can use installed plugins and a private website sign-in flow. Their cloud
browser has its own session; being signed in to OpenChat on your personal
browser does not sign the dot in. If your dot asks you to sign in to
`id.ideaflow.app`, use its private sign-in request to connect the website.
That request is separate from whether your OpenChat API key is valid.

**Copy agent setup** is intended for agents that accept an API key and can make
HTTP requests, such as Hermes. It does not install a ChatGPT plugin. OpenChat
currently ships a local MCP adapter, not a hosted OAuth MCP connection for
dots. Unlinked's hosted MCP connection does not grant OpenChat messaging access.

For a future OpenChat plugin, the intended flow is **Connect OpenChat → Ideaflow
ID → approve access → connected**, with a read-only account/conversation check.
That integration still needs implementation; no “one-click dot setup” is live.

References: [Dots computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
and [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth).

## Post to conversation Context

In the app: open a conversation → **Context** → type a note → **Post**.
Context is visible to that conversation's participants, quietly, without a
chat notification. It is not your private notebook or public ask discovery.

The **same OpenChat API key** works here. Reading needs `read`; creating,
editing, or deleting needs `write`. You must still belong to the conversation.

```bash
curl -H "Authorization: Bearer $OPENCHAT_API_KEY" \
  https://chat.ideaflow.app/api/chat/conversations/CONVERSATION_ID/context

curl -X POST -H "Authorization: Bearer $OPENCHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Context to share","kind":"note","clientRequestId":"unique-post-id"}' \
  https://chat.ideaflow.app/api/chat/conversations/CONVERSATION_ID/context
```

Use **`text`** for Context; normal chat messages use **`content`**.
`clientRequestId` must be a unique string per post. Reuse it when retrying the
same post so a timeout does not create duplicates. `kind` is `note` (default),
`ask`, or `offer`. An ask in Context does not activate anonymous public matching.
`GET` returns `{ "posts": [...], "nextCursor": "…" }`.
MCP exposes `oc_list_context_posts`, `oc_create_context_post`, and
`oc_delete_context_post` through the same key.

## If setup fails

| Result | What to check |
|---|---|
| 401 | Send `Authorization: Bearer <key>` on every request. Check expiration/revocation and that you used the credential for the right app. |
| 403 on Context | Check conversation membership and the key's `read`/`write` scopes. A normal read/write OpenChat key needs no separate Context grant. |
| 400 | Read the returned error: Context needs `text` and `clientRequestId`; chat needs `content`. |
| 404 | Check the full API path and conversation ID; Context also requires the server feature to be enabled. |
| 429 | Respect the Context publication limit and retry later with the same `clientRequestId`. |
| Agent cannot call HTTP | Use an MCP-capable client or another supported tool connection. Pasting text alone does not give an agent network tools. |

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
local stdio servers, follow the maintained build and client configuration in
[`apps/mcp-server/README.md`](https://github.com/IdeaFlowCo/OpenChat/blob/main/apps/mcp-server/README.md). That document also
owns the tool inventory and confirmation requirements. A plain consumer ChatGPT
session cannot run a local stdio MCP server; use a compatible MCP client or
import OpenChat's `/api/openapi.json` into a Custom GPT Action.

### Plain REST

Scripts can call the same endpoints directly:

```bash
KEY="oc_<your-key>"
BASE_URL="https://chat.ideaflow.app"

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

The live agent integration has no OpenChat-hosted `/mcp` HTTP endpoint, no OAuth
or Dynamic Client Registration, and no npm package publication. The separate
[Ideaflow connector preparation](https://github.com/IdeaFlowCo/OpenChat/blob/main/docs/connector-delegation-integration-packet.md)
is a disabled authorization-code harness, not a live connector. The MCP adapter
runs locally over stdio (or on infrastructure you host). Context enforces read/write key scopes and current conversation membership.
Some older chat endpoints still act with the owning user's permissions rather
than enforcing scope labels; do not treat a read-only label as a global guarantee.

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
  "baseUrl": "https://chat.ideaflow.app"
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

Context enforces the scopes on the same key used for chat:

| Scope | Capability |
|-------|-----------|
| `read` | Read conversation Context |
| `write` | Create, edit, and delete conversation Context, subject to membership and authorship |

Default: both `read` and `write`. Some older chat endpoints still act with the
owning user’s permissions rather than enforcing scope labels. Do not treat a
read-only label as a global restriction on every endpoint. Context checks the
current stored key on each operation, including revocation and expiration.

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
*you*. See the [MCP server tool inventory](https://github.com/IdeaFlowCo/OpenChat/blob/main/apps/mcp-server/README.md#tools)
for the maintained list of chat, private-capture, Story, matching, review, and
preference tools plus their approval requirements.

Source: <https://github.com/IdeaFlowCo/OpenChat/tree/main/apps/mcp-server>

Build and configuration instructions for Claude Desktop, Cursor, Codex CLI,
Claude Code, and HTTP clients are maintained in the
[MCP server README](https://github.com/IdeaFlowCo/OpenChat/blob/main/apps/mcp-server/README.md#30-second-setup).

### How bi-directional access works

- **Outbound:** every tool call hits the OpenChat REST API as you. Messages
  show up in conversations as if you sent them.
- **Inbound:** the agent calls `oc_list_conversations` / `oc_get_messages` to
  read incoming messages. Polling remains the MCP-server path; service bots
  that need push should use `/api/webhooks`.

Your agent acts as you. Context enforces read/write scopes; see the scope
limitations for older endpoints above.

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
