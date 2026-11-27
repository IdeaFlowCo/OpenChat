# Beeper replies: separate write authority

The native **Chats → Beeper chats → Beeper replies** flow is a separate write
capability. Read grants cannot send. This source is being assembled and tested;
it has no independent write-security/release approval or actual account/device
activation yet. Optional iMessage remains a separate open provider task.

A Mac owner approves exactly one WhatsApp account/chat, pinned device/Mac keys,
OpenChat owner, destination and expiry. A fresh write-only offer/token uses
`openchat.beeper.send.v1` / `beeper.send`, never the agent turn protocol or a read
resolver. Source IDs stay in the Mac authority; the native app imports the
owner-confirmed encrypted target. It keeps each draft encrypted locally, with
small SecureStore hash/sequence/operation pins. Preparing a draft creates no cloud
request. Submitting records the operation durably before its first HTTP request.

The cloud transports sealed intent and receipt boxes only. A queue entry, title,
HTTP acknowledgment or server `done` flag cannot become source permission or
confirmation. The Mac verifies the pinned write scope, authenticates the native
body and asks locally for **this exact message** before source dispatch. Native
status changes require the Mac's authenticated receipt for that exact frame,
operation and monotonic revision. The UI calls a `SUCCESS` receipt **Beeper
confirmed the send**; it does not claim every recipient received or read it.

The outbox records an attempt durably before provider work. A dropped response or
crash never causes a second POST or a different-Mac failover. A known pending ID
can be queried on its original Mac; an unknown attempt without an ID requires
local review. The native app can explicitly transport the same encrypted request
again after a dropped enqueue response, but cannot re-sign it, change text/target
or rebind its operation to another Mac. Expired unsubmitted drafts may be
discarded locally; submitted/unknown attempts cannot be cleared as if unsent.
Passive owner-local status remains visible when a target grant expires or is
missing. Viewing that metadata never loads keys, signs or retries a request.

The provider adapter uses fixed loopback paths, designated local write credentials,
GET preflight, a single text POST and a pending-ID status GET. It refuses merged
automatic routing, a changed account/chat, read-only targets and unsupported
reply capabilities. It does not upload media, mark chats read, invoke shell/agent
commands or fetch source URLs. Revocation/stop is checked after asynchronous
credential lookup at actual dispatch. A provider POST already initiated cannot be
recalled by revoking a grant afterward.

## Manual activation after review and delivery

Only Jacob starts and enrolls the actual Mac/device integration. Do not run these
commands on his behalf or install a service/launch hook. This source does not
create a provider token or sign into any account. Existing designated Keychain
entries are selected explicitly; no credential discovery or Mac database/profile
migration occurs.

```sh
node scripts/beeper-client/writeForeground.mjs setup \
  --pair-route PAIR_ROUTE --owner OPENCHAT_USER_ID \
  --account LOCAL_WHATSAPP_ACCOUNT --chat LOCAL_MEMBER_CHAT_ID \
  --read-service DESIGNATED_READ_SERVICE --read-account DESIGNATED_READ_ACCOUNT \
  --write-service DESIGNATED_WRITE_SERVICE --write-account DESIGNATED_WRITE_ACCOUNT
```

This confirms the local metadata lookup and then the write grant. Import its
printed encrypted offer in the paired native app, confirm its authenticated
chat/expiry/Mac, and approve the private relay. No token or private key is printed.

```sh
node scripts/beeper-client/writeForeground.mjs run --connection CONNECTION_ID
```

The worker runs in the foreground only, and asks for literal `send` for each
message. Ctrl-C stops it. On the native app, review a draft, then choose **Send
reply for Mac approval**. **Retry the same request** preserves the original
ciphertext and Mac after an uncertain transport response; it is never a provider
send retry. A local **Discard prepared reply** applies only before submission.

```sh
node scripts/beeper-client/writeForeground.mjs revoke --connection CONNECTION_ID
```

Local revoke does not wait for the foreground process lease, and fences later
source/status dispatch on the shared authority ledger. Device-local disable stops
future native authorizations; cloud revoke stops honest-relay claims. Neither can
recall a request already admitted on an offline Mac or an already started provider
send. Use Mac-local revoke to enforce the machine authority boundary.

Private state defaults to `~/.config/openchat-beeper-write`; the existing parent
identity defaults to `~/.paseo/openchat-machine`. Explicit private-directory flags
are supported. No credentials, identity DB or outbox should be copied to GCP.

## Provider contract checked

The official [send API](https://developers.beeper.com/desktop-api-reference/typescript/resources/messages/methods/send/)
returns a pending message ID. The [message lookup](https://developers.beeper.com/desktop-api-reference/typescript/resources/messages/methods/retrieve/)
accepts that ID and exposes bridge send status. No provider idempotency key is
assumed. [Merged chats](https://developers.beeper.com/desktop-api-reference/typescript/resources/chats/methods/retrieve/)
can choose a different member automatically, so writes target an explicitly
approved member instead. These docs and synthetic tests do not verify a real
Mac/account, transport behavior on Apple hardware or an actual message delivery.
