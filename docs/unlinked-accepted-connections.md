# Accepted Unlinked connections in OpenChat

For the user-facing behavior, see [Message with OpenChat from Unlinked](../README.md#message-with-openchat-from-unlinked).
This document owns the confidential acceptance synchronization contract.

The confidential POST `/api/unlinked/connections/accepted` uses the existing
`UNLINKED_MESSAGING_SECRET`, rejects browser Origin headers and ordinary agent
credentials, and validates the canonical Ideaflow issuer and two distinct opaque
subjects. The Unlinked server supplies identities resolved from active owner
bindings and the original accepted request ID/time. Neither names nor email are
identity evidence. Only display names accompany the identity; request notes,
private contact details and local Unlinked owner IDs are excluded.

A unique `UnlinkedConnectionSync.requestId` receipt pins the accepted event to its
identity binding. The receipt, inbox resolution and canonical DM creation commit
in one transaction. Ordered user ACL locks serialize this operation with blocks
and local relationship changes. An event reused with different identities or
acceptance time returns 409. Repeated and racing valid events reuse one receipt
and the same canonical pair DM. A completed receipt returns its stored result
without reapplying the event or reevaluating suppression. On first processing,
blocked/bot pairs and local declined/removed
relationships produce a terminal suppressed receipt, so replay after unblock
cannot revive that event. A pre-existing OpenChat friendship is not changed.

Unlinked's durable accepted request is its delivery queue. Startup and five-second
reconciliation select at most ten due unacknowledged rows, resolve active identities
and recheck acceptance before dispatch. An immediate wake follows acceptance,
including crossed requests. Failures keep the same request ID and use persisted
exponential backoff from five seconds to one hour. A lost response is safe to
retry. Acknowledgement is conditional on the same still-accepted request. Removed,
withdrawn, ignored, pending or deleted requests are not newly dispatched. Removal
in Unlinked does not delete an already-created chat or its history; a delivery
already in flight may finish. OpenChat's own block remains authoritative.

No credential is minted. Deploy the receiver and its additive constraint before
the sender worker. An absent messaging secret disables delivery; receiver outages
leave accepted requests retryable. Existing accepted requests without an ack are
reconciled as well. There is no external-send transport or subscription. Source
validation uses fictional identities and a disposable database only. Production
merge/deployment remains subject to the existing release-owner holds.

Validation: server route and real Neo4j tests cover authentication, identity
conflicts, concurrency, DM reuse, suppression, no messages/friend grants; sender
behavior tests cover recipient authorization, crossed acceptance, lost response,
persisted retry, restart, removed requests and missing identity bindings.

## Shared Noos boundary

The sync ledger must retain only the `UnlinkedConnectionSync` label. Never add
`Node`, `File`, `User`, `Person`, or projection labels; expose its properties in
public node/file/People/WIT/overlay exports; attach generic content/file references;
or grant generic ownership, sharing, public, or unlisted access to receipts.
Keep the dedicated authenticated receiver and conversation membership checks.
Raw Cypher ingress must remain deny-by-default with an empty operator allowlist.

The independent read-only receipt `acl-boundary-receipt.json` from
`unlinked-sync-noos-acl-20261008` verifies that deployed Noos commit
`25fe2c59d3cdf7f4592127a7002770e1250b409c` uses label-scoped routes that exclude
this standalone record. This separation is structural, not a protected-label
marker. The receipt reports closed raw-query ingress and HTTP 403 on the public
query route. It involved no production ledger insertion and does not establish
end-to-end HTTP denial for a deployed ledger, protection from privileged database
access, or safety of future routes that bypass label selection. It grants no
release authorization: all merge, deployment, and restart holds remain in force.
The `Unlinked` prefix is not an ACL, and `OperationalResource` must not be added
as a security marker.

`unlinkedConnections.integration.test.ts` creates a synthetic receipt through
the authenticated receiver, then checks its exact operational label, absence of
relationships and generic sharing/content properties, and nonselection of that
known graph element by the audited `Node` and `File` selectors. This regression
checks the stored graph boundary, not the Noos HTTP handlers or privileged access.

Graph CI runs `directConversationPrivacy.test.ts` against its isolated Neo4j
service to verify returned participant placeholders, real-email non-disclosure,
member-only visibility, block behavior, and property-linked first-message previews.
