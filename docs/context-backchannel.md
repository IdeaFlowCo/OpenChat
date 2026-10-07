# Context back-channel

Context is shared conversation content with quiet delivery. Posts, replies, edits,
deletes, reports and agent requests never create a Message, update chat preview or
read state, dispatch ordinary chat webhooks, or send human notifications. No private
notes are automatically read or shared. Ask and Offer currently label shared text;
they do not create another AgentIntent lifecycle or enable network matching.

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
   at most one enabled key per participant (stable key-ID ordering), capped at ten
   participants. It excludes blocked relationships and the calling key itself.
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
explicit owner approval before publication. This API cannot inspect an external
agent's private sources and does not provide a private-data approval UI.

This release supplies a functioning pull inbox, not a hosted autonomous assistant
runner or external webhook. Agents need an active polling loop to process requests;
enabling the key does not launch a process. Existing Asks/Stories/AgentIntent
lifecycles remain separate until their publication/audience contracts are reconciled.

## Verification

`contextBackchannel.integration.test.ts` runs against an isolated Neo4j configured
with `NEO4J_TEST_URI` (optional `NEO4J_TEST_USER`/`NEO4J_TEST_PASSWORD`). It exercises
actual Cypher for authorship, replies, conflicting retries, edits, search, equal-time
pagination, reports, opt-in, recipient isolation, blocked requests, completion,
tombstones, and unchanged ordinary chat state. Route tests cover malformed inputs
and same-key scope/revocation behavior. Do not substitute production for this test DB.
