# Hosted Context drafts and human approval

Hosted Context is optional per owner and off by default. The server is available
only with `OPENCHAT_CONTEXT_LANE=true`, `OPENCHAT_CONTEXT_HOSTED_ENABLED=true`, and
the existing Anthropic provider credential. Deployment must forward the hosted
flag into the server container. Missing configuration is exposed as
`available:false`; no account is enrolled automatically.

A person explicitly selects **Ask agents** on an existing shared Context post.
For each eligible conversation member, the hosted worker takes precedence when
that member has opted in and the service is available; otherwise the existing
opted-in external key is used. At most one recipient per owner is queued. Ordinary
Context posts do not wake agents. Existing external agents continue to poll their
existing inbox and use the same read/write API key.

The worker has no tools. Its only inputs are the snapshotted shared post and any
private text the owner explicitly supplies for that request. Supplying text sends
it to the existing Anthropic provider for processing; no private store is fetched.
All generated output remains an owner-private draft. No ordinary Message, push,
unread count, last-read marker or conversation ordering is changed.

## Human review API

All routes below are under `/api/chat/context-hosted`, require a direct human
session JWT, and reject agent keys, connector operation tokens and embedded
sessions. These operations are absent from the connector tool catalog.

- `GET /preferences`, `PUT /preferences {enabled:boolean}` return
  `{enabled,available}`. Changing preference increments a generation and cancels
  unfinished requests; repeated identical settings are idempotent.
- `GET /requests?conversationId=...` returns `{requests}` (up to 50, actionable
  requests first). `GET /requests/:id` returns one owner-only request.
- `POST /requests/:id/revise` accepts exactly one of `{text}` (new immutable
  reviewed draft) or `{privateText}` (explicit selected input, max 8000 characters,
  requeues generation; empty string clears it).
- `POST /requests/:id/publish {draftId,approvalDigest,text}` publishes exactly the
  current reviewed text as one quiet Context reply, with server attribution
  `OpenChat Agent (owner approved)`. Repeated approval returns the same post after
  rechecking access. Other payload fields cannot choose the owner or destination.
- `POST /requests/:id/decline` and `/cancel` erase draft text and selected private
  input. Mutation responses are the direct updated request.

A request includes destination title, source text/revision/author, exact audience
IDs/names, expiry, owner-selected private input and the current draft's exact text
and approval digest. Each immutable digest binds these values, owner preference
generation and request version. Publication locks the relevant users and
conversation and rechecks source, membership, blocks, opt-in generation, exact
current audience/title, draft expiry and exact approval in the same transaction
as creation. A changed audience/source/permission cancels availability and
redacts source/audience/private content from reads. Stale requests require a new
Ask; clients must not automatically resubmit approval after a conflict.

## Durable worker limits and retention

The worker polls every 15 seconds. A unique database singleton serializes claims;
leases recover after 90 seconds, with at most two processing requests globally.
Each model call times out after 25 seconds, uses the existing configured assistant
model (default `claude-haiku-4-5`), at most 1024 output tokens and no SDK retries.
Each request gets three attempts, delayed retries, six attempts per owner per hour
and 60 globally per hour. Ask requests retain the existing 30-recipient hourly
budget. Changing selected input invalidates the old lease and requires a new
review, without resetting hourly budgets. Provider failures expose only a generic
message and never publish output.

Requests expire after 24 hours; each approval draft expires after at most one hour.
The cleanup cycle erases expired input/drafts even if model generation is globally
disabled, and checks up to 50 active requests per cycle in least-recently-checked
order for invalidated permissions. Revision erases superseded drafts; opt-out,
decline, cancellation and account deletion erase relevant private snapshots.
Publishing clears selected private input; the final immutable draft is retained
until request expiry for exact idempotency verification.

## Validation

`contextHosted.integration.test.ts` uses an isolated real Neo4j with synthetic
accounts and an injected fake model. It verifies approval, privacy, quiet replies,
concurrent publication, stale model results, opt-out, ACL/source/audience changes,
lease recovery, budgets, retention and deletion. `contextHosted.route.test.ts`
exercises real JWT and connector-operation authentication boundaries. No real
account is enrolled and no real model or user message is used by these tests.
