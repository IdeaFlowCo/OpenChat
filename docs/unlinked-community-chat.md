# Unlinked community chats

Unlinked community membership includes its chat. Unlinked owns the roster;
OpenChat stores the conversation and messages. The existing dedicated server
credential authorizes POST `/api/unlinked/groups/sync`; browser Origins and
ordinary member tokens are rejected. No extra service credential is provisioned.

The versioned payload contains groupId, positive revision, name, organizer and
members (verified Ideaflow issuer/subject/name), and deleted. Members excludes
the organizer. At most 500 total members are accepted. `existingConversationId`
is an optional immutable migration binding: the organizer must already own that
existing group conversation; a missing migration target is rejected. Otherwise a deterministic ID is derived from the group UUID.

Repeated identical revisions converge. Older revisions and conflicting equal
revisions fail with409. A deleted group leaves a tombstone, removes participants,
and cannot be resurrected by a later old roster. History is preserved. No message
or notification push is generated. Socket membership and inbox events update the
ordinary clients. Publication takes the conversation lock and checks the accepted
revision before sending projections. Manual mutations commit before a separate
locked publication revalidates access; invite responses and inbox effects use
that same publication boundary. Message events select current per-user recipients
under the roster lock, including edits, deletions, reactions, forwarding, previews
and transcripts. Thought pins, shared thought edits, profile text and read
updates also use current per-user recipients rather than cached conversation rooms. A socket awaiting eviction cannot receive revoked content. Identical retries replay inbox discovery for
all current members and any unacknowledged removals; pending removals survive a
projection failure or a newer roster. Existing mute/read settings remain on retained memberships.

Managed chats cannot admit users through standalone invitations or participant
edits: manage membership or leave through Unlinked. Existing chat invitations are
revoked when the group becomes managed. Quick-emoji customization stays available;
the synchronized title remains owned by Unlinked. WhatsApp remains independent.

Unlinked's durable outbox retries failed deliveries. Until a delivery succeeds,
OpenChat retains the last accepted roster; this is not an atomic cross-service
membership transaction. The UI uses `/messages/c/<id>` in Unlinked by default and
`/app/chat/<id>` as the optional separate OpenChat view. Do not activate the
Unlinked producer before deploying and verifying this endpoint. Bind existing
Boulder chat `44HsMDzl6YZ7l1AdNusAT` to its existing group to preserve history.

Tests: `test/unlinkedGroups.integration.test.ts` exercises actual HTTP with an
isolated Neo4j: confidential authentication, concurrency, normal inboxes, removal,
stale updates, deletion, migration, retained messages and invitation denial.
`test/unlinkedGroups.races.integration.test.ts` covers real socket events, delayed
publication, projection failures and retries, stale joins, migration races in manual
mutations, transaction rollback, invite acceptance during migration, delayed
eviction, ordered message delivery, direct-chat reactions, safe persisted names
and emoji customization. Delayed-eviction coverage includes new/existing thought
pins, edits through canonical and legacy sharing relationships, and profile text.
Never use production credentials or a live graph for those tests.
