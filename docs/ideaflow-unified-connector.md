# Unified Ideaflow connector: OpenChat adapter

OpenChat is a downstream app of the shared Ideaflow connector. The user's host
connects once to the identity-provider connector, then grants the desired app
scopes. This adapter does not issue API keys or create/link accounts automatically.
Existing manual OpenChat keys remain supported.

## Service configuration

Set `IDEAFLOW_CONNECTOR_SECRET` to the dedicated OpenChat adapter secret provisioned
in the connector gateway. It must contain at least 32 bytes. Keep this distinct
from all session/JWT/API-key-encryption secrets. The adapter is unavailable with
HTTP 503 while it is unconfigured. Do not put secrets in URLs or client bundles.

The gateway sends `POST /api/connector/mcp` with `Content-Type: application/json`
and an HS256 assertion in `Authorization: Bearer …`. Claims:

- `iss`: `https://id.ideaflow.app/connector`
- `aud`: `https://chat.ideaflow.app/mcp`
- `identity_issuer`: `https://id.ideaflow.app/api/auth`
- `sub`: linked Ideaflow subject; lookup requires the exact stored issuer/subject
- `scope`: space-separated `openchat:read` and/or `openchat:write`
- `iat`, `exp`: integer seconds, lifetime at most 60 seconds
- `jti`: unique identifier for each assertion, including retries
- `body_sha256`: lowercase SHA-256 hex digest of the exact UTF-8 HTTP request body

Raw bytes are verified before JSON parsing. The assertion is accepted once, only
by the adapter; it is never a normal OpenChat bearer token. Replay tracking is
process-local for the current single-process server deployment. Multiple replicas
would need shared replay storage before this trust boundary is scaled out.

If there is no unique User matching `ideaflowIssuer` and `ideaflowSub`, the adapter
returns HTTP 409 `account_link_required`. It never looks up by email, merges users,
or creates an account. The user must first link their intended OpenChat account
through normal Ideaflow sign-in.

## Tools and permissions

The adapter handles JSON-RPC initialization, ping, `tools/list`, and `tools/call`.
Read scope exposes `oc_list_conversations`, `oc_get_messages`, `oc_search`, and
`oc_list_context_posts`, plus the additive read-only
[`oc_list_conversation_content`](conversation-content.md). Write scope exposes `oc_send_message`,
`oc_create_context_post`, `oc_update_context_post`, `oc_delete_context_post`, and
`oc_ask_context_agents`. Direct calls enforce the same scopes even when a tool was
not advertised. Unknown fields and tools are rejected. Write scope does not imply
read scope.

### Private people knowledge

The owner's [private graph](private-graph.md) (the shared Noos people overlay,
also shown in Unlinked) is exposed with the same scope split. Read scope adds
`oc_get_person_private`, `oc_get_unlinked_person_private`, `oc_list_private_links`,
`oc_list_private_things`, `oc_get_private_thing` and `oc_list_catch_up`. Write
scope adds `oc_set_person_private`, `oc_add_private_note`, `oc_delete_private_note`,
`oc_add_private_link`, `oc_delete_private_link` and `oc_save_private_thing`. Through the hub they appear as
`openchat__oc_…`. A subject or link target can be an OpenChat person (`user`), a
saved thing, or an Unlinked profile (`unlinked`, stored as the overlay ref
`unlinked:person:<profileId>`). Connector requests reach `/api/private` with the
connector's own scope names: `GET` needs `openchat:read`, every change needs
`openchat:write`. Ambiguous names return HTTP 409 with `code: "ambiguous_name"`
and `candidates`, surfaced to the agent as a tool error.

Normal messages require `content` and a stable `clientRequestId`; use only after
the user requests sending. Context posts require `text` and `clientRequestId`,
with optional `replyToId` and `kind`. Retries use the original `clientRequestId`
but a new gateway assertion. Context posts display **Ideaflow connector · for
[person]** using server-derived provenance. Quiet Context behavior and the opt-in
agent request system are documented in [Context back-channel](context-backchannel.md).

Each permitted call maps to a fixed existing REST operation. A random server-only
one-use credential binds its user, method, exact path/query, and parsed body hash;
it expires after 30 seconds and is never returned to the gateway. The guard consumes
it and stores trust in a WeakMap keyed by the actual Express request. No caller
header or JSON field can impersonate this trust. Existing REST membership,
ownership, block, revision and Context checks remain in force. The loopback target
uses the actual listening port, never the caller's Host or URL arguments.

## Validation

`apps/server/test/ideaflowConnector.test.ts` checks exact byte/signature validation,
replay protection, identity lookup, separately enforced scopes, schema restrictions,
normal-route assertion rejection, one-use operation binding, membership denial,
and connector attribution without sending any real messages.
`apps/server/test/ideaflowConnector.privateGraph.test.ts` checks the private-graph
tool catalog, scope split, dispatch as the linked owner and ambiguous-name results. The Context graph
suite runs separately against an isolated Neo4j database.
