# Beeper chats in OpenChat

The Beeper chats door is available from Chats on phone and desktop. A private
connection can list minimal source-chat metadata, reserve an explicit selected
read, and open its saved copy in the existing Conversation, People, Asks and
Memory reader. Refresh creates a new source request; reloading the saved copy
alone never claims to have refreshed Beeper.

This source milestone is read-only. It does not enable sending, mark messages
read, focus a source chat, retrieve media URLs or import contacts. Histories are
partial and preserve source edits and explicit tombstones; an absent row is not
a deletion. Source timestamps do not order scans: server epochs do.

## Authorization and activation boundary

A connection offer contains public keys, an opaque source account key and the
hash of a dedicated importer token plus an HMAC of the immutable recipient/scope tuple. Approving it in OpenChat scopes that
importer to one owner and account. It cannot authorize a Mac operation. The
importer credential never works as an ordinary OpenChat session or agent key.

A separate reviewed device capability must bind the machine/device keys,
route, audience `beeper.read`, exact locally approved account and selected-chat
keys, destination and grant expiry. It authenticates each typed read with
sequence and revocation checks on the Mac before any GET. A catalogue row or
server job cannot select or enlarge that local scope. The client defaults to
**Authorization required** until this capability is installed; no fallback
signer or server-issued machine authority exists. The source now includes this typed verifier and native registry, with a manual
foreground runner. Their independent exact-head review and delivery are still
required; source tests do not constitute activation. See
[manual Mac operations](beeper-client-operations.md).

The GET-only adapter uses the fixed loopback Beeper Desktop API and a token
supplied locally by the caller. It discovers no credentials and has no Messages
SQLite fallback. Actual enrollment, local source authorization, listener start
and disclosure approval remain owner actions. Builds never perform them.

## Relay and imported data

Dedicated relay routes authenticate before accepting the larger import body.
Mutations lock owner, connection, job and imported chat in that order. Import,
immutable-conflict rejection, batch receipt, sequence advance and final success
are one graph transaction. Repeated identical batches receive the old receipt;
changed retries fail. Current connection, epoch and lease fences reject stale
uploads. Account deletion removes transport metadata inside its existing owner
fence; export excludes token verifiers and sealed intents. Metadata/receipts
expire after seven days, while saved chat/history and scan epochs remain.

## Explicit remaining product scope

Read activation still requires independent exact-head source/security approval,
synthetic end-to-end/browser checks and coordinated server, web and native
delivery. The implemented verifier, registry and foreground runner remain inert
until the actual owner performs the separate local approvals and native actions. No real source chat has been read for these
tests. Source tests do not verify macOS or a physical iPhone.

The full client request also includes capability-gated replies and optional
iMessage. Replies need a durable outbox with stable operation IDs: persist an
attempt before provider dispatch, pin uncertain attempts to the original Mac,
and reconcile status rather than retrying through a different Mac. A write
capability and actual deliberate send need separate local authorization. Native
iMessage remains an explicit Mac-local provider subtask; there is no silent
fallback to a Mac database, AppleScript command or generic agent prompt.
