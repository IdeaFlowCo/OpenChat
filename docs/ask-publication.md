# Durable ask publication

A canonical private ask and its public/selected-person publication are separate records. Saving an ask never publishes, starts matching, sends a message, creates an inbox or notifies anyone. Source quotes, notes, carrier/placement metadata and unresolved audience wording remain owner-only.

Profile → All asks → Details & sources includes **Profile visibility**. An owner can select the exact publication text, Public or verified people, review that output, and press Publish. Public includes signed-out viewers. Selected-person visibility binds verified account identities, not display names, email guesses, private contacts or chat membership. Unlinked identity resolution is read-only; unclaimed profiles or missing accounts keep the private ask saved without creating an account/inbox or grant. Profile → Shared with me is available in basic mode; a contact profile shows sanitized published asks independently of Stories.

Publication lasts until revoked and has a revision separate from the private source revision. Private edits and fulfillment do not rewrite the approved snapshot. The owner sees a version-difference label and must review an update explicitly. Private withdrawal atomically revokes; explicit Revoke retains the canonical ask. Revocation prevents subsequent authorized server reads, counts and cursor pages; it cannot recall text already read or downloaded. Public text can still be read signed out even when that person is blocked while signed in.

## Owner protocol

All owner routes inherit authenticated owner resolution and read/write scopes from privateGraph. Responses use `Cache-Control: private, no-store`.

| Route | Purpose |
|---|---|
| `GET /api/private/asks/:id/publication` | Current owner publication, recipient summaries and source-version comparison |
| `POST /api/private/asks/:id/publication` | Preview with `confirm:false`; commit with the identical payload, `confirm:true` and its approval grant |
| `DELETE /api/private/asks/:id/publication` | Revoke with `expectedPublicationRevision` |

The POST payload is `{requestId, expectedAskRevision, expectedPublicationRevision, text, audience, confirm, approvalGrant?}`. Audience is `{kind:'public'}` or `{kind:'people',targets:[{kind:'openchat_user'|'unlinked_profile',id}]}` (at most twenty). Another person's privately recorded ask cannot be published by this v1 flow. The owner cannot select another owner, resolved identity keys or provenance in the body.

The existing publicationApproval mechanism binds each ten-minute, single-use grant to actor, action, exact text, verified recipients and expected revisions. Names, accounts, blocks and source/publication revisions are rechecked on commit. The canonical ask and owner-scoped operation receipt are locked in the same transaction. Exact committed retries return the original commit reference/revision plus current publication state without needing another grant or reactivating revoked content. Changed request payloads conflict. If approval was consumed but no commit occurred, a fresh review is required.

Hosted private-assistant tools `get_ask_publication`, `publish_ask` and `revoke_ask_publication` use the same service/gate. Shared-chat scope denies them. Exact pending publication reviews are kept in a bounded ten-minute owner/conversation buffer (at most twenty per conversation) and reinjected only into the next universal private model turn; tokens are not shown to the user. Confirmation requires a later authenticated user message, so a model cannot preview and activate on the same turn. Each review completes separately, and expired/restarted buffers require fresh review without losing the saved ask. This buffer supplies model continuity; the existing publicationApproval grant and transaction remain the authorization boundary. Saving is immediate; only the established exact publication review asks for confirmation. Existing Story and quiet-search activation remain separate actions.

## Viewer boundary

| Route | Purpose |
|---|---|
| `GET /api/ask-publications/:id` | One sanitized snapshot for an optional authenticated viewer |
| `GET /api/people/:userId/ask-publications` | Only this publisher's currently readable snapshots |
| `GET /api/ask-publications/shared-with-me` | Required-auth selected-person inbox |

Missing credentials mean public-only access. Present invalid credentials fail authentication rather than downgrade to anonymous. Private evidence and owner inventory APIs remain mandatory-auth/owner-only. Viewer DTOs contain only publication ID/revision, approved text/lifecycle snapshot, dates, safe publisher attribution and `public` or `shared_with_you`; no canonical ask IDs, recipient lists, principal hashes, source IDs or private relationships.

Every read requires active publication, existing source ask/publisher and live viewer/account policy. Mutual blocks exclude authenticated non-owner reads. ACLs apply before pagination; no private totals are emitted. Cursors are signed and bound to viewer, publisher/filter and stable ordering. All responses are no-store, including public snapshots in this first version; no targeted offline persistence, shared ETags, OG previews or public search index is introduced. Source/account deletion and owner rekey maintain publication and operation records.

## Verification and release boundary

Synthetic regression coverage includes public marketing, Vlad-only party invitees and private VC introductions, with owner/recipient/stranger/anonymous reads; no real-user replay occurs during development. Disposable Neo4j tests cover snapshots, approval, retries, block, cursor and revocation behavior. Native render tests cover exact review payloads, selected accounts, unknown visibility and account-switch clearing.

Source/CI completion is not deployment or real publication. The prior production release gate still applies to the paired Noos/OpenChat release. Unlinked/Social/WIT/Gestalt source projections use the read-adapter contract and remain separate follow-ups; no historical extraction or pending contact-import dataset is automatically copied or published.
