# Context request webhooks

Context webhooks are an optional wake-up mechanism for an external agent's existing
Context request inbox. They are separate from message webhooks and hosted drafts.
Nothing subscribes automatically, and enabling hosted drafts takes precedence over
that owner's external keys for new requests.

From Chats, choose **Agent drafts → Set up webhooks**. A direct human session must
select one conversation, an owned active read/write key with Context requests
already enabled, and a public HTTPS endpoint. The screen reviews that destination
and requires explicit approval before **Enable webhook**. Agent keys, delegated
connector tokens and embedded sessions cannot approve endpoints. Membership and
key authorization are checked again on creation and before each delivery.

The server flag `OPENCHAT_CONTEXT_WEBHOOKS_ENABLED=true` enables this optional
transport. Its deployment default is **false**. Polling works independently. This
release does not create production subscriptions or send a real webhook as a
test. The operator may enable availability independently; each owner must still
explicitly approve their own destination in the product. During a rollout that
prohibits sends, verify there are no existing active subscriptions or pending
deliveries before enabling availability.

## Receiver contract

A `POST` contains only:

```json
{"id":"stable-event-id","event":"context.requested","requestId":"request-id"}
```

No shared post text, conversation title, participant identity, private notes or
messages are in that payload. Fetch the pending request using the receiving key's
existing `/api/chat/context-agent/requests` inbox. Its live ACL checks remain
mandatory. A wake-up is not authorization to run tools, disclose private sources,
contact someone or publish a reply without the owner's applicable approval.

Verify `X-OpenChat-Signature: sha256=<hex>` against HMAC-SHA256 using the signing
secret and the exact bytes `X-OpenChat-Timestamp + "." + rawRequestBody`. The
timestamp is Unix time in seconds. Check a short timestamp tolerance (for example five minutes), compare the signature in
constant time, then deduplicate by body `id` / `X-OpenChat-Event-Id`. No raw secret
is sent in an HTTP header. Return a 2xx response only after durably accepting the
event. Retries preserve the event ID but receive a fresh timestamp/signature.

At-least-once delivery means a crash after receiver acceptance can cause a repeat.
There are at most four attempts, with 30-second, two-minute and ten-minute backoff,
a 30-second recoverable lease, and at most two simultaneous claimed deliveries.
Requests expire after 24 hours. DNS is bounded to two seconds and HTTP to five;
private/reserved addresses, credentials, fragments, non-HTTPS URLs and redirects
are rejected. DNS answers are pinned for the request. The legacy local webhook
exception never enables local Context destinations.

The outbox is created atomically with a new explicit Context request, only while
transport availability is enabled, for subscriptions already present. There is no replay of old requests on opt-in.
Source revisions, lifecycle closure, blocks, membership removal, request completion,
key revocation/expiry/scope changes and opt-out cancel stale deliveries. Unsubscribe
cancels pending deliveries and removes the secret. Delivery metadata expires seven
days after request expiry; account deletion removes its subscriptions and events.
Cleanup continues even while outbound delivery is disabled.

## API

All setup routes are human-session-only and `Cache-Control: no-store`:

- `GET /api/chat/context-webhooks`: availability and owned subscriptions, without secrets.
- `POST /api/chat/context-webhooks`: `url`, `conversationId`, `agentKeyId`,
  `clientRequestId`, and `consent:true`; returns subscription and signing secret.
- `DELETE /api/chat/context-webhooks/:id`: disables and cancels queued deliveries.

Creation is idempotent for the same request and destination, including secret
recovery after a lost response. One active subscription per key/conversation and
ten active subscriptions per owner are allowed. A changed destination requires
removal and new explicit approval. Existing ordinary message subscriptions are
unaffected.

## Validation

`contextWebhooks.integration.test.ts` uses isolated Neo4j records and an injected
transport: it creates no production subscriptions and makes no external sends.
It covers consent, deduplication, minimal payload, retries, leases, kill switch,
expiry, unsubscribe, source changes, membership, key revocation and blocks.
`contextWebhookSetup.mobile.test.ts` checks destination consent and invalidation.
