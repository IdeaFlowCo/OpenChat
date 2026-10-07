# Private profile capture and contextual agent

OpenChat-2cmf implements the profile review approved on 6 October 2026. User-facing work lives in the canonical Expo client and uses Warm Paper + System Sans. Existing theme choices persist; new installs start light and optional dark surfaces are softer.

From People, save a person privately even without an OpenChat account, then open Private profile. From a member's profile, use Capture a private note. Save note preserves the original wording independently of AI. Save & review updates asks the existing Anthropic provider for source-backed private asks and typed connections. The source excerpt must occur in the note. A direct Add ask path bypasses AI. Neither path publishes, binds an account, sends an invitation, or starts matching.

Review lets the owner edit/select suggestions. Exact duplicates are skipped, similar asks are flagged, and applying is atomic. Undo uses a durable transaction ledger and removes only that review's newly created asks/links; original notes and pre-existing records remain. Later ask edits block destructive undo. The destination entities remain because other notes/links can use them. Deleting a source note redacts its review snapshot and proposals; already-applied graph records remain, with undo still available.

The Noos-owned overlay contract is unchanged. Canonical OverlayNote and OVERLAY_LINK records carry notes/connections, while additive owner-key-scoped OpenChatNoteReview/OpenChatPrivateAsk nodes hold capture history and private third-party asks. Owner export, deletion and identity rekey include these additions. A saved person's name does not establish a verified account link.

Ask agent is available through labeled headers and profile/conversation entry points. Its context card shows the current page and lets the owner exclude saved context from the next message. The server resolves the subject under the authenticated owner's permissions and posts to that owner's private Assistant DM. Context already sent stays in that private conversation; switching the include toggle does not erase past messages. Profile context includes notes, typed connections, private ask statuses and catch-up metadata. Conversation context includes the latest 12 readable messages when selected.

Gemini 3.8 Flash reviewed the prototype through Vertex before implementation. Its recommendations led to durable undo, per-account/person drafts and retry keys, keyboard shortcuts, focus announcements, editable proposals and explicit provenance. The review, with identifying examples replaced, is adjacent in `profile-note-gemini-review-20261007.txt`.

Validation includes route authentication/scope tests, mobile async account/subject switching tests, source-deletion privacy tests and live isolated Neo4j tests for concurrent retries, duplicate application, rollback after partial writes, durable undo and later-edit conflicts. Browser checks use a disposable database and synthetic accounts, never real contact identities.

This release implements profile capture/contextual agent behavior. Earlier central SMS and individual-number alternatives remain separate planned work under OpenChat-q7l0.
