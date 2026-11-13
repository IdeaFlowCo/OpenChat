# Unlinked community chats

For user-facing behavior, see [Message with OpenChat from Unlinked](../README.md#message-with-openchat-from-unlinked).
This document owns the confidential community roster synchronization contract.
Unlinked owns the roster; OpenChat stores the conversation and messages.

## Confidential snapshot API

`POST /api/unlinked/groups/sync` requires `Authorization: Bearer <UNLINKED_MESSAGING_SECRET>`
using the existing dedicated service credential (at least 32 characters).
Browser Origin headers are rejected, as are ordinary member or agent tokens.
Responses use `Cache-Control: no-store`. No extra credential is provisioned.

The body contains only these fields; unknown fields, including member fields,
are rejected:

| Field | Contract |
|---|---|
| `groupId` | Lowercase UUID v4, fixed for the community. |
| `revision` | Positive safe integer, increasing whenever snapshot contents change. |
| `name` | Nonblank group title, at most 100 characters. |
| `organizer` | `{issuer, subject, name}` resolved by the trusted producer from the organizer's verified identity. |
| `members` | Array of the same identity objects, excluding the organizer; at most 499 entries, with no duplicate subjects. |
| `deleted` | Required boolean; `true` removes all participants while preserving history. |
| `existingConversationId` | Optional immutable migration binding, 1–100 ASCII letters, digits, underscores or hyphens. Include it on every subsequent snapshot and retry for that binding. |

Every identity has issuer `https://id.ideaflow.app/api/auth`, an opaque subject
of 1–512 characters without whitespace or ASCII controls, and a display name of
at most 160 characters. Names are display-only and normalized when provisioning
an inbox. Only verified issuer/subject bindings select accounts; no email,
private contact fields or message content belong in the payload. Missing inboxes
are materialized through the [shared account contract](unlinked-compose-contract.md).

The organizer identity and conversation binding cannot change. A migration
requires an existing group conversation already owned by that organizer; a
missing target, direct chat, other owner's chat or conflicting managed binding
is rejected. Otherwise the conversation ID is `uc_` followed by the first 32
hex characters of SHA-256 of `groupId`. Migration retains existing messages;
retained memberships keep their mute/read settings.

Success returns HTTP 200 with `{conversationId, revision}`. Identical equal
revisions converge regardless of JSON member-field or roster order: fingerprints
use fixed-order member tuples sorted by subject. Older revisions return
`409 stale_group_snapshot`; conflicting equal revisions return
`409 group_revision_conflict`. A deleted group keeps a tombstone and cannot be
restored, even with a higher revision. Other conflicts return
`409 group_binding_conflict` or `409 conversation_binding_conflict`.
Invalid payloads return `400 invalid_group_snapshot`, invalid credentials return
`401 unauthorized`, and browser Origins return `403 forbidden`. Missing or short
service configuration and unexpected synchronization/publication failures return
`503 group_sync_unavailable`. A 503 can follow a committed roster update, so retry
the identical snapshot rather than assuming rollback.

## Access and live projections

Roster synchronization creates no messages, invitations or notification pushes.
Existing chat invitations are revoked on migration. Standalone title, participant
and invite-creation mutations return 409 for managed chats; invite acceptance
returns 410. Quick-emoji changes remain authorized for current participants.
Roster projection includes blocked pairs when both belong to the community;
the existing message-send block checks still apply. WhatsApp remains independent.

Publication takes the conversation ACL lock and checks the accepted revision
before emitting projections. Current members receive `conversation:created`
with `{conversationId, conversation}` through their per-user socket rooms, even
on identical retries. Removed members are evicted from conversation rooms and
receive `participant:removed` with only `{conversationId, userId}`. Pending
removals survive publication failures and newer rosters until acknowledged.
Manual mutations commit before a separate locked publication revalidates access;
invite responses and inbox effects use that same publication boundary.

Message events select current per-user recipients under the roster lock,
including edits, deletions, reactions, forwarding, previews and transcripts.
Thought pins, shared thought edits, profile text and read updates use that
boundary too. A socket awaiting room eviction cannot receive those revoked
content events through stale room membership.

## Paired rollout and regression coverage

The paired Unlinked producer/native/slugs change is reviewed separately at
`unlinked-native-community-chat-20261113`. Its producer must durably retry failed
deliveries: until a delivery succeeds, OpenChat retains the last accepted roster.
This is not an atomic cross-service membership transaction. The paired UI's
default destination is Unlinked `/messages/c/<id>`; `/app/chat/<id>` is the
optional separate OpenChat view. Do not activate the producer before deploying
and verifying this endpoint through curated live release coordination. Pipeline
validation must not mutate production. Bind existing Boulder chat
`44HsMDzl6YZ7l1AdNusAT` to its existing group to preserve history.

[HTTP/Neo4j integration tests](../apps/server/test/unlinkedGroups.integration.test.ts)
cover authentication, concurrent retries, normal inboxes, removal, stale updates,
deletion, migration, retained messages and invitation denial.
[Race integration tests](../apps/server/test/unlinkedGroups.races.integration.test.ts)
cover publication ordering, failed projections and retries, stale joins, manual
mutation/migration races, delayed eviction, content fanout, direct-chat reactions,
safe persisted names and emoji customization. These suites require
`NEO4J_TEST_URI`, `NEO4J_TEST_PASSWORD` and optionally `NEO4J_TEST_USER` (default
`neo4j`); without the URI they skip. Never use production credentials or a live
graph for these tests.
