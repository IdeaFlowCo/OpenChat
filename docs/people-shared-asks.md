# People shared ask feed

The Ideaflow connector exposes `oc_list_story_feed` under the existing `openchat:read` permission. It reuses `GET /api/stories/feed` as the exact linked OpenChat viewer, optionally narrowed by `authorId`. No new grant, publishing operation or notification is introduced.

The existing Story service enforces audience, membership, blocks, expiry and human visibility. The connector uses the human projection: Story text, author, creation time and Story expiry. Agent-search structured terms and owner-private standing asks are separate and are not included.

People labels this source “Shared with me.” Its “My people” feed uses the separate owner-private standing asks and saved notes. Stored exposure on a private ask is not a publication grant.

Validation: the connector HTTP regression fails with400 on the previous main and passes with the bridge. Focused tests exercise read grants, exact linked viewer/author, human redaction, invalid arguments, unlinked accounts and empty feeds. Existing Story service privacy/integration tests remain authoritative for audience evaluation. No real Stories or messages are created by these tests.
