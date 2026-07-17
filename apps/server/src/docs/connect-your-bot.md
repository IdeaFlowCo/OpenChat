# Connect your bot in 30 seconds

OpenChat supports agent API keys so any bot or script can read and send messages
using a standard `Authorization: Bearer` header. The key authenticates as the
owning user: messages sent with an agent key appear as that user, not as a
separate bot identity. Dedicated service bots can instead own their own key and
receive push delivery through outbound webhooks.

## Quickstart

```bash
KEY="oc_<your-key>"
BASE_URL="https://chat.globalbr.ai"

curl -H "Authorization: Bearer $KEY" \
  "$BASE_URL/api/chat/conversations"
```

## Send A Message

Use `content` for message text:

```bash
curl -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello from my agent"}' \
  "$BASE_URL/api/chat/conversations/<conversation-id>/messages"
```

For compatibility, the API also accepts `text` as an alias, but new code should
send `content`.

## Create A Direct Message

```bash
curl -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"participantIds":["<user-id>"],"type":"direct"}' \
  "$BASE_URL/api/chat/conversations"
```

Passing your own user id creates or returns a self-DM.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chat/conversations` | List conversations |
| `POST` | `/api/chat/conversations` | Create a conversation |
| `GET` | `/api/chat/conversations/:id/messages` | Get messages |
| `POST` | `/api/chat/conversations/:id/messages` | Send a message |
| `POST` | `/api/chat/messages/:id/reactions` | Add a plain reaction or a semantic receipt reaction |
| `DELETE` | `/api/chat/messages/:id/reactions/:emoji` | Remove your plain reaction; add `?kind=filed` to remove a filed receipt |
| `GET` | `/api/agent-keys` | List agent keys |
| `POST` | `/api/agent-keys` | Mint an agent key |
| `POST` | `/api/webhooks` | Create an outbound webhook subscription |
| `GET` | `/api/webhooks` | List webhook subscriptions |
| `DELETE` | `/api/webhooks/:id` | Delete a webhook subscription |

Plain reactions use `👍 ❤️ 😂 😮 😢 🙏`:

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

Agent keys have default-on capability flags. They can do everything a user
session can unless a key is explicitly narrowed later.

## Outbound Webhooks

Use webhooks when an external service should receive new messages without
polling:

```bash
curl -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-service.example/openchat/webhook","events":["message.created"]}' \
  "$BASE_URL/api/webhooks"
```

The create response returns a shared `secret` once. Each delivery posts:

```json
{
  "event": "message.created",
  "message": {
    "id": "...",
    "conversationId": "...",
    "senderId": "...",
    "senderName": "...",
    "content": "...",
    "messageType": "text",
    "attachments": null,
    "replyToId": null,
    "createdAt": "2026-07-16T00:00:00.000Z"
  }
}
```

Deliveries include both verification headers:

- `X-OpenChat-Secret: <secret>` for a direct shared-secret check.
- `X-OpenChat-Signature: sha256=<hex>` for an HMAC-SHA256 of the exact body.

Delivery is fire-and-forget with a 5 s timeout and one retry. Webhooks created
with an agent key are deactivated when that key is revoked.

## Dedicated Bot Users

Most agent keys act as their owning human. First-class external services can
use a dedicated bot user instead. The GroupBrain user (`id: "groupbrain"`,
`isBot: true`) is created idempotently on server boot and is distinct from the
in-app `assistant` user. A key owned by that user lets GroupBrain send messages,
react, and receive `message.created` webhooks as its own OpenChat identity.
