# OpenChat connector delegation preparation

This revision provides a disabled OpenChat-owned test route and a four-tool
adapter for later use inside the existing Ideaflow connector. It does not add
tools to that installed connector. The OpenChat API's production route stays
disabled, and this revision must not be deployed as an activation change.

## Boundaries

- Only `oc_list_conversations`, `oc_get_messages`, `oc_search_messages`, and
  `oc_send_message` are eligible. The adapter reuses the typed REST client and
  schemas in `apps/mcp-server/src/connectorTools.ts`. It resolves a delegation
  for each call, checks connector grant, connector user, OpenChat user, expiry,
  and read/send scope, then calls one fixed server-owned upstream origin.
- The OpenChat route guard accepts `ocd_` bearer credentials only on `GET
  /api/chat/conversations`, `GET /api/chat/conversations/:id/messages`, `GET
  /api/chat/search`, and `POST /api/chat/conversations/:id/messages`. It uses
  the named OpenChat user and the existing chat routes' membership, block,
  and directory checks. All other routes reject that credential. Existing
  user JWT and `oc_` agent-key behavior remains in place.
- The relying party authenticates with a dedicated client secret. Its `/start`
  request names the connector grant and connector account, exact registered
  callback, random state, requested scopes, and SHA-256 PKCE challenge. A
  signed-in OpenChat user reviews the request; that review binds the transaction
  to that account. The user explicitly approves read,
  with send approved separately. `/token` consumes the code once after exact
  callback, state, client, and verifier checks. `/revoke` invalidates pending transactions, codes, and tokens
  matching the client, connector grant, connector account, and OpenChat user.
- A send call requires a stable `clientRequestId`; the OpenChat route derives a
  message ID bound to client, connector grant/account, and OpenChat account so retries preserve one message. The REST route
  keeps the exact content for delegated sends and suppresses retry side
  effects. Tool errors use fixed text and never return bearer credentials.

## Disabled test harness

`OPENCHAT_CONNECTOR_DELEGATION_ENABLED=true` and a valid
`OPENCHAT_CONNECTOR_CLIENTS_JSON` can enable the local route only when
`NODE_ENV` is not `production`. The JSON is an array of objects with `id`,
`secret`, and `callbacks` (exact HTTPS callback URLs). No callback or client
is registered by default. Do not use real connector credentials in this
in-process harness. `apps/server/test/connectorDelegation.test.ts` exercises a
fake relying party and fake chat upstream; it sends no production messages.

The in-process authorization store deliberately does not survive restart or
work across server replicas. Production activation needs a durable, atomic
one-use code and revocation store, an encrypted relying-party grant store,
login-owner review of account/session boundaries, and an explicit release
decision. The [reviewable integration packet](connector-delegation-integration-packet.md)
names these gates and the exact protected endpoint exception. This component is preparation, not a live connector.
