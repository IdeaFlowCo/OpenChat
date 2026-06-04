# Connect your bot in 30 seconds

OpenChat supports agent API keys so any bot or script can read and send messages
using a standard `Authorization: Bearer` header. The key authenticates as the
owning user: messages sent with an agent key appear as that user, not as a
separate bot identity.

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
| `GET` | `/api/agent-keys` | List agent keys |
| `POST` | `/api/agent-keys` | Mint an agent key |

Agent keys have default-on capability flags. They can do everything a user
session can unless a key is explicitly narrowed later.
