# Profile ask publication (source, rollout held)

`OpenChat-whxy.6` / `unlinked-uoj` add owner-authored asks to Unlinked profiles
through canonical OpenChat Stories. Merge, deployment, production configuration
and graph changes, native builds and restarts remain explicitly held by the
coordination/release owner. This is source delivery, not a live feature claim.

The confidential `POST /api/unlinked/profile-asks` accepts only the dedicated
`UNLINKED_MESSAGING_SECRET` without a browser Origin. The verified Unlinked server
supplies exact Ideaflow issuer/subject `owner` and optional `viewer`, plus
`operation: list|audience|publish|edit|close|remove`. Mutations require owner and
viewer equality; list uses exact existing inbox bindings, never names or email,
and never provisions an account. Only publish lazily materializes the ordinary
shared inbox if absent. Missing service configuration is 503, not an empty list.

Publication creates an `OpenChatStory` with `showOnProfile:true`, explicit
`profileVisibility:private|selected|public`, `profileRevision`, and a linked
canonical `AgentIntent`. It is Context-only, matching paused, with agent search
false. No second ask store or automatic Context/quiet-search publication exists.
Existing Stories default to no profile publication and remain available in their
ordinary authorized feed. Public permission is explicit for new profile asks;
selected users and conversations use the existing Story ACL. Both owner and
viewer must still belong to a selected conversation. Both-way blocks, expiry,
withdrawal and removed projections fail closed without hidden counts.

Owner operations require `expectedRevision`, serialized owner/story locks and
live selected audiences. Edit changes the human-approved text and visibility.
For profile-created requests, canonical goal/seeks update too; linked Context
posts remain their independently approved text and are marked source-changed.
Close calls canonical intention fulfillment; remove calls withdrawal plus a
Story tombstone. Existing Context and Story lifecycle changes also revoke the
profile projection. Closed intentions cannot be republished. Fifty active profile
asks per owner bound reads and writes; expiry is limited to one year.

The public reader DTO is `{id,kind:'ask',text,expiresAt}`. Owner inventory adds
revision, visibility, status and selected audience IDs; no match/draft/counterparty
internals cross the adapter. HTTP is no-store and rate-limited. Unlinked public
People JSON, agent grants and AI search acquire no ask surface.

`/api/unlinked/recipient` additionally accepts optional opaque `askId` alongside
its strict public `profile` URL. After confidential profile ownership resolution,
it rechecks the ask belongs to that exact owner and is active, unexpired and
readable by the authenticated user. Response adds only `{id,text,expiresAt}`.
Missing/revoked/foreign asks are unavailable and create no conversation/message.
The compose client opens the normal verified direct thread and queues context in
account/thread-scoped memory. **About this ask → Add ask to draft** explicitly
appends to the current draft; **Dismiss** leaves it alone. Normal Send is still
required. Account switches clear pending context. Links contain no text or identity.

Existing OpenChat profile/feed Stories show the same approved text, audience and
lifecycle. The Unlinked owner controls are the publication door for this release;
no new native screen or native build is required. The two-product release must
put this OpenChat receiver and the canonical web client before Unlinked's adapter.
Coordinate held PR154 message UI and PR155 accepted-connection receiver changes;
no empty DM may create friendship/Context permission. Preserve PR155's additive
route mount and transactional shared-inbox helper during source merges.

Executable tests:

- `profileAskPublication.integration.test.ts`: real isolated Neo4j, public/private/
  selected/group/anonymous/block/expiry/revocation, canonical lifecycle, old Story
  compatibility, exact identity and confidential route auth, addressed ask entry.
- `profileAskEntry.mobile.test.ts`: executed compose + context banner, correct
  owner/thread/account, retained draft, revoked entry and strict URL grammar.
- The graph cases run in the existing mobile regression graph CI job. All fixtures
  are controlled synthetic personas; tests never post for a real member.
