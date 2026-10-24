# From a private imported chat to a shared conversation

Status: proposed contract, 2026-10-23. Tracked by `OpenChat-yzw5`.
The private import mechanism is shipped; identity claims and shared-history
promotion described here are not implemented. No migration is authorized by
an import or by this document alone.

## Existing behavior and prior decisions

A person can be represented before signup. An imported participant has a stable
source identity and a mini-profile, independent of a User account. The archive
belongs to its importing owner. Source messages retain their author, timestamp
and ID; membership in the source chat does not grant OpenChat access.

The existing [shared inbox contract](unlinked-compose-contract.md) already
preserves an inbox and direct-conversation history when an **existing verified
Ideaflow identity** first signs in. It does not prove who an imported WhatsApp
participant is. Names and imported email addresses never merge identities.

The October 2 shadow-profile proposal required a verified identity, explicit
confirmation, and an expiring single-use invitation. Claiming did not transfer
the inviter's private notes/history. The October 23
[imported-chat contract](imported-chat-mirrors.md#later-account-claims) deferred
account linking and retained that privacy boundary. This proposal adds the
separate, explicit shared-history step needed for continuity.

## Proposed user flow

1. **Private history now.** The owner imports a direct chat and can read it under
   Imported chats. The other person has no account, membership, notifications or
   access created on their behalf. The UI says whose private copy this is.
2. **Verify the person later.** The person signs into their own Ideaflow account.
   A claim challenge proves control of the exact source-network identity through
   an approved adapter. A phone-to-WhatsApp-LID mapping must itself be verified;
   names, contact labels, screenshots, a matching typed number, and possession
   of an invitation are insufficient. The owner also confirms that this is the
   intended person, accounting for recycled numbers. If proof is unavailable,
   leave the imported profile unlinked; an ordinary new chat remains possible.
3. **Confirm the link.** Both see which profile and account are being connected.
   The recipient sees only the owner's deliberately offered minimal profile,
   not the private archive. Single-use, expiring challenges bind the exact source,
   intended account and claim attempt. A completed link changes display identity
   without rewriting historic attribution or granting archive access.
4. **Choose history to share.** The owner selects a bounded set of messages or a
   date range and sees an exact preview, count, missing-media notice and proposed
   destination. Private notes, inferred profile facts, private ask statuses,
   unrelated conversations and future imports are excluded. An explicit Share
   action grants access only to this review package for the verified recipient.
5. **Accept history and continue.** The recipient reviews the offered package
   and accepts or declines. Acceptance atomically attaches the agreed historical
   segment to their canonical direct conversation, reusing an existing DM for
   the same pair where one exists. Future OpenChat messages use its normal
   composer and sending rules. Declining leaves the private archive intact and
   does not add any shared history.

The result feels like one conversation: an “Imported from WhatsApp” segment
followed by new OpenChat messages. The private original remains separately
owned; the shared segment is an explicit, bounded copy with its own access.

## Proposed records and invariants

| Record | Purpose |
| --- | --- |
| Source identity | Namespace + verified source account identifier; names are labels, never keys. Existing chat-scoped participant IDs remain stable. |
| Identity claim | Source identity, exact issuer/subject, proof method and receipt, verification time, owner confirmation, status and revocation history. No grant to private archives. |
| History share | Owner, verified recipient, destination pair, immutable selected-message manifest/hash, preview version, grant time, recipient acceptance and lifecycle state. Changing selection requires new consent. |
| Shared historical message | Original network/source identity/message ID, author label at source, source time, import time, content revision/hash and history-share receipt. Display identity links never overwrite these. |
| Continuity link | Private archive → canonical DM plus accepted share receipt. Resolving the link checks access; it never exposes another owner's archive ID or contents. |

Use the existing unique canonical direct-conversation pair, never create a DM
by display name. Concurrent claims/promotions must serialize and be idempotent.
Uniqueness for shared history includes destination conversation, verified source
conversation namespace and original message ID. Retries and overlapping imports
reuse the same historical entry. If source identities or namespaces cannot be
proved equivalent, require review instead of guessing or silently merging.
Conflicting text stays a disclosed revision/conflict, not a second authored
message. A claim proves current identity control; it does not retroactively prove
that every historical source message was personally authored by the claimant.

Promotion is atomic: bind both accepted accounts, validate access/blocking and
the accepted manifest, get/create the canonical DM, insert deduplicated history,
record the receipt. Historical insertion must not replay sends, bot triggers,
matching, push notifications or old unread counts. It must not pretend that
the other person sent a new OpenChat message at import time. A user-approved invitation or
share notification is a separate explicit action.

Source deletions and later edits never silently enlarge the accepted share.
Define removal/revision handling before implementation; preserve tombstones and
provenance and notify affected readers where appropriate. Revoking a pending
share removes review access. Revoking a claim blocks future promotion but does
not rewrite old authorship. Removing accepted shared history follows the shared
conversation's deletion policy; do not promise to erase copies already received.

## Implementation acceptance

- A claimed profile alone cannot read any private imported chat or notes.
- Wrong account, expired/reused challenge, unverified aliases, blocked pairs,
  changed manifests and revoked grants fail closed.
- Both participants approve the exact bounded history; future imports remain
  private until separately shared.
- Repeated/concurrent acceptance produces one DM and one historical message per
  source ID, with exact text, original timestamps and retained provenance.
- Existing DM links keep working; account signup does not fork the conversation.
- Source gaps and omitted media remain visible after promotion.
- Account deletion/export cover claim and sharing records with explicit ownership
  rules; deleting one private archive does not delete another person's account.

This contract applies to direct chats. Group promotion needs per-participant
membership and history-sharing rules before it can use the same mechanism.
