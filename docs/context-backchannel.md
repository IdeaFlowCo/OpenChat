# Context back-channel

Context is shared conversation content with quiet delivery. Posts, replies, edits,
deletes, reports and agent requests never create a Message, update chat preview or
read state, dispatch ordinary chat webhooks, or send human notifications. No private
notes are automatically read or shared. Ask and Offer currently label shared text;
they do not create another AgentIntent lifecycle or enable network matching.

The app refreshes Context on focus/foreground and periodically, rather than
through push events. If refresh fails, **Retry** reloads the feed; cached posts
remain visible. Pull to refresh is also available.

Returning to a conversation with Back keeps its selected Chat or Context lane.
Opening a notification, banner or Context link instead selects its destination
as described in [the user guide](../README.md#notifications-and-conversation-links).

## Posts

Use the same OpenChat read/write API key and conversation membership as Chat. No
additional grant is required. `GET /api/chat/conversations/:id/context` supports
`search` (case insensitive, up to 200 characters), `kind`, `limit` (1–100), and the
opaque `nextCursor` returned by the previous page. Equal timestamps do not skip
posts. The default page size is 50. Newest posts come first.

Create with `{text,clientRequestId,kind?,replyToId?}`. Text is at most 20,000
characters. Reuse the same request ID and payload after a timeout; changing the
payload with that ID returns 409. Retries retain the original post identity even
if it has since been edited or deleted. Replies must refer to a live Context post
in the same conversation. Edit with `{text,expectedRevision}`; stale revisions
return 409. Deletion removes the body and retains a tombstone for thread and retry
integrity. The author or group owner can delete; only the author can edit.

Projection includes `author:{id,name}`, optional `agent:{id,name}`, and optional
`replyTo:{id,text,author,isDeleted}`. Agent attribution derives from the authenticated
key, never a client-supplied name. Existing historical posts retain their known
author; they are not retroactively labeled as agent-authored. Deleted parent
previews have empty text. `POST .../context/:postId/report` takes `{reason,freeform?}`
and stores a standard Report without exporting the shared body to a webhook.

## Explicit agent requests

1. A key owner enables **Receive Context requests** in that key's settings, or
   explicitly instructs its agent to call `oc_set_context_requests_enabled`.
   API: `PUT /api/chat/context-agent/preferences` with `{enabled:true}` using that
   agent key; a human JWT additionally supplies an owned `keyId`. Off by default.
2. A member explicitly selects **Ask agents** on a post. API:
   `POST /api/chat/conversations/:id/context/:postId/ask-agents`. The server queues
   at most one agent per participant, capped at ten participants. An explicitly
   enabled hosted agent takes precedence; otherwise it uses stable enabled key-ID ordering. It excludes blocked relationships and the calling key itself.
   Repeating the same source revision does not create another request. Budget:
   thirty recipient requests per requester per hour. Requests expire after 24 hours.
3. Enabled agents poll `GET /api/chat/context-agent/requests` or
   `oc_list_context_agent_requests`. Only the receiving key can read its inbox.
   Each poll checks live membership, block state, scopes, expiry/revocation,
   opt-in, source deletion and exact revision. Edited sources require a fresh ask.
4. The agent may decline with `{decline:true}` or respond with `{text}` at
   `POST /api/chat/context-agent/requests/:requestId/respond` (MCP:
   `oc_respond_to_context_agent_request`). Response and request completion commit
   together, producing one shared, attributed threaded reply on retries. Declines
   stay private and generate no chat content.

An incoming request is untrusted shared data. It grants no permission to run tools,
contact people, access other conversations, or disclose the agent owner's private
information. Replies may contain already-shared information; private facts need
explicit owner approval before publication. This pull API cannot inspect an external agent's private sources. The hosted
review flow below provides an explicit approval boundary for hosted drafts.

External key-based agents still need an active polling loop; enabling a key does
not launch a process. External webhooks and the existing Asks/Stories/AgentIntent
lifecycles remain separate.

## Hosted drafts and private sharing

From Chats, select **Agent drafts**. The hosted agent is off for every owner until
that owner enables it. A server availability switch alone never enrolls anyone.
Screen readers announce the **Hosted Context agent** switch's current on/off
state on web and native clients.
The screen explains that enabling hosted drafts takes precedence over that owner's
key-based request recipient.

An explicit **Ask agents** request can now queue a bounded hosted turn. Anthropic
receives the selected shared Context post, plus only private text that the owner
explicitly supplies for this request. No private notes are fetched automatically.
The model has no tools. Generation creates an owner-private draft; it cannot
publish Context, send messages, or send notifications.

The owner sees the source revision, any supplied private text, the exact proposed
reply, destination and current audience. Editing saves a new draft for another
review. **Publish to Context** is a separate action submitting the exact draft ID,
text and approval digest. A live membership, source, audience, display-metadata or
opt-in change invalidates approval. Context is durable shared content: current
and future authorized conversation members and their agents can read a published
reply. This is not a promise to restrict the post forever to the review snapshot.

Only a normal signed-in owner session can use the private review routes. Agent
keys, embedded sessions, unified connector principals and delegated operations
cannot approve drafts. API/MCP scope consent does not substitute for this product
approval. Published replies carry server-derived **OpenChat Agent (owner approved)**
attribution and use the existing quiet, threaded Context write path.

Hosted routes live under `/api/chat/context-hosted`: `GET/PUT /preferences`,
`GET /requests`, `GET /requests/:id`, and `POST /requests/:id/{revise,publish,decline,cancel}`.
Revision accepts either `text` or `privateText`, never both. An empty `privateText`
removes supplied private material and requests a new draft. Publication accepts
`{draftId,approvalDigest,text}`. Requests expire after 24 hours and individual
reviews after at most one hour. Retrying the same successful approval returns the
same post while access remains valid.

The worker uses durable 90-second leases, at most two active generations globally,
a 25-second model timeout and three attempts per generation. Budgets allow six
attempts per owner per hour and sixty globally. Turning off cancels pending work,
invalidates in-flight output and removes unpublished drafts/private input.
Obsolete revisions, expired or invalid requests, and account deletion clean up
private drafts. Server availability requires `OPENCHAT_CONTEXT_LANE`,
`OPENCHAT_CONTEXT_HOSTED_ENABLED=true`, and the existing `ANTHROPIC_API_KEY`.
`ASSISTANT_MODEL` retains the existing provider configuration. No new API key is
created for hosted execution.

## Verification

`contextBackchannel.integration.test.ts` runs against an isolated Neo4j configured
with `NEO4J_TEST_URI` (optional `NEO4J_TEST_USER`/`NEO4J_TEST_PASSWORD`). It exercises
actual Cypher for authorship, replies, conflicting retries, edits, search, equal-time
pagination, reports, opt-in, recipient isolation, blocked requests, completion,
tombstones, and unchanged ordinary chat state. Route tests cover malformed inputs
and same-key scope/revocation behavior. Do not substitute production for this test DB.
