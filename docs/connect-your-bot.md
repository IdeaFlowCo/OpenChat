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

### Agent key management

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/agent-keys` | List your keys (no plaintext) |
| `POST`   | `/api/agent-keys` | Mint a new key |
| `GET`    | `/api/agent-keys/:id/reveal` | Get plaintext key |
| `PATCH`  | `/api/agent-keys/:id` | Rename / change scopes |
| `DELETE` | `/api/agent-keys/:id` | Revoke a key |

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

## MCP server

An OpenChat MCP server (OpenChat-5xq) is on the roadmap. Once available it will
let you configure Claude Desktop or Cursor to talk to OpenChat with a single
JSON snippet.
