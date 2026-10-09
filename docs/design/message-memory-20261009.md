# Message-to-person memory — first design exploration

Status: proposal, not implementation. October 9, 2026. Tracking: OpenChat-poh4.

Open `.lavish/message-memory/index.html` for the portable interactive concept.
Lavish review: https://m4-mini.tailb2a35c.ts.net:4387/session/ed3737bf08174057

## User intent

Start with an always-on Mac observing iMessage. A configured reaction or hashtag reply captures knowledge about a person. Explore a familiar full messaging client for mobile and desktop, WhatsApp, separate versus combined streams, standalone versus OpenChat packaging, and a possible relationship to Notestream Vision.

Working assumption (not yet confirmed): captured knowledge is the owner's private memory about a person, not an automatic edit to that person's shared profile.

## Recommended shape

Begin with a small companion, then optionally expand to a messaging client. Keep one reusable person-memory module that can also appear inside OpenChat. Share the record/API across surfaces rather than creating an independent store to migrate later. No new product name or repository is needed at this stage.

One person, separate network conversations by default, an optional combined chronological history. All-history messages retain channel labels; the composer explicitly names the destination and preserves it when the reader switches tabs. Groups remain separate threads. Identity links are reversible and uncertain matches require review.

The desktop client has an inbox, central conversation, and optional private memory panel. On phone the conversation fills the screen, and a visible Memory button opens the same information. Familiarity is the design target; full iMessage capability parity has not been established.

## Capture semantics

- Owner's configured reaction (provisional example: pin emoji) or explicit reply containing #remember. Both are visible to the other party in Apple Messages. Verify custom emoji event support on the target Mac before committing to that trigger.
- Our own client's Remember action is private. A voice command must resolve a specific message; ambiguous targets show candidates.
- Explicit captures save immediately with Undo. Store original excerpt and provenance before extraction; extraction errors must not lose the capture. Mark low-confidence subject assignment, conflicting facts, and third-party claims for review.
- Preserve epistemic and temporal qualifiers. A plan to move is not a current address. The subject may differ from the sender, especially in groups.
- Only the owner's gestures count. Historical markers do not auto-import at activation. Quoted markers do not count as reply commands. Replies require stable source linkage.
- Idempotency across replay and different gestures: owner + source account + source message + capture intent. Source revisions and marker removals need separate event IDs and checkpoints.
- Removing a marker withdraws an unedited gesture capture; an edited memory receives a removed-marker notice with Forget. Undo/Forget changes memory, not the source conversation.
- Source edits flag potential staleness; source deletion marks it unavailable. Do not silently overwrite reviewed memory. Forget propagates to derived search indexes and linked views.
- No automatic publication or outgoing action. Treat message content as data, never instructions to the connector, extraction service, or sharing system.

## Proposed data boundary

Use existing stores and APIs where suitable; these are logical entities, not a mandate for new tables:

- Person: stable ID, linked channel handles, owner scope, reversible matching provenance. No requirement that the person be an OpenChat member.
- Conversation: source account/network/thread ID and membership history. Never merge source thread IDs.
- Capture: stable ID, owner, source account/network/message/revision/thread, source sender and timestamp, capture timestamp/method, original excerpt, bounded context, linked person IDs, extraction/review state.
- Memory/note: stable canonical note ID, private owner, derived wording, source capture ID, observed/planned time, review state, supersedes links, edits, deletion tombstone.
- Connector: authenticated paired Mac, capability map, checkpoint, health/last sync, replay and send-attempt state.

The observer writes a durable capture event, deduplicates it, then sends only the necessary excerpt/context to the authorized memory service. The service saves a source-backed note; person profile and Vision stream read views of it. Define the authoritative store and deletion contract before implementation. Existing OpenChat and Vision stores are not already unified. Avoid dual writes without stable mapping and retry/tombstone handling.

A Mac connection needs authenticated pairing, encrypted transport, bounded local data access, durable checkpointing, and explicit last-sync state. The source network's end-to-end encryption does not automatically cover copies sent to a new memory backend or model. Select processing/storage boundaries deliberately during the connector spike.

## Offline and messaging behavior

Cached history and memories remain available. Private capture intentions can be queued locally and marked pending until acknowledged. If the Mac is offline, do not represent a send as delivered. Distinguish draft, queued, submitting, sent, failed, and uncertain outcomes; reconcile an uncertain send before retrying. Channel adapters expose capability support so unsupported reactions, read state, replies, edits, attachments, groups, or notifications are not presented as working.

The interactive demo is a state illustration, with no persistence, real connectors, AI extraction, notifications, identity resolution, microphone capture, or actual message transmission. A production phone client, push relay, encrypted sync, distribution, and feature parity remain implementation work.

## Vision connection, supported by repository evidence

OpenChat `docs/thoughts-design.md`, resolved decision D13, names NoteStream as the eventual canonical note store but says OpenChat retains Thought nodes for now. Provenance and ownership fields already appear in that design. Do not reuse historic hashtag capture defaults that expose group notes for this new private-person capture mode.

Vision `src/renderer/src/lib/peek-capture-service.ts` has a real desktop capture path through its existing note/sync machinery. `.lavish/note-that-capture-mock.html` explores intentional “note that” capture; it is a design reference, not proof that every depicted behavior ships. `server/src/outbox/adapters/imessage.ts` explicitly returns not_configured: the iMessage adapter is a stub. The related Mac/Hermes bridge is note dispatch, not proof of a general inbound iMessage connector.

Suggested shared abstraction: intentional capture + source + owner + subject links. Person memory, Vision stream, and OpenChat recall can be views over one note. Do not pull a full messaging UI into Vision just to reuse capture.

## Feasibility sources, consulted October 9, 2026

- https://docs.bluebubbles.app/server — Mac Messages database observation, AppleScript sending, optional private API bundle.
- https://docs.bluebubbles.app/client — client capabilities and distinction for private API features.
- https://developer.apple.com/documentation/TelephonyMessagingKit — SMS/MMS/RCS scope and eligibility restrictions; not an iMessage inbox API.

These sources support a bridge-based exploration, not a promise of seamless replacement. Verify reaction sender/target, custom emoji, reply linkage, removals, edits, reconnects, background notifications, and attachment behavior on the actual OS. Do not alter system security configuration as part of this design task. WhatsApp personal-account connector selection and validation are explicitly unresolved; do not assume business API access means personal inbox access.

## First implementation slice

1. Observe an explicitly selected test thread on the target Mac and prove capture event identity/replay.
2. Save one private source-backed memory with deduplication, person assignment, review, Undo, and Forget.
3. Expose it on phone and desktop while Apple Messages remains the messaging client.
4. Prove capture once, reconnect without duplication, find under correct person, inspect source, and forget across views.
5. After this succeeds, scope full-client sending, delivery, notifications, attachments and groups independently, followed by WhatsApp integration.

This is a proposed sequence, not authorization to deploy a connector or read private messages in this session.

## Visual design decisions

Domain: conversation, sender, person, reply, remembered detail, original wording, source time, channel.
Color world: the current approved OpenChat paper surface, dark message ink, secondary metadata, restrained sienna actions, subtle paper-edge borders, semantic status.
Signature: a message becomes a dated private memory that points back to its original wording. The same person panel survives network switching.
Defaults avoided: a CRM dashboard, automatically merged network chats, and a social feed required for private recall.

Intent: Jacob remembers a detail while chatting, with minimal interaction and reliable source recall.
Hierarchy: conversation first, memory secondary, source on demand. Desktop columns 220px / flexible / 300px; phone uses one view at a time.
Palette/type: reuse current approved OpenChat Warm Paper + System Sans from origin/main 1399220c, not the stale serif theme in the pre-fetch local checkout.
Depth: subtle borders; source dialog layered above the message surface.
Spacing: 4px base, 12–20px component padding, 14px body, 18px chat title, 22px section title. Native controls, visible action words, focus rings, responsive layout, reduced-motion support.

## Validation

Browser interaction checks passed: save, source dialog, all-history display, route preservation with an existing draft, offline send disablement, Undo, companion capture. At 390px emulated mobile width: document scroll width is 390px and the memory navigation opens its panel. Screenshot export was blocked by the existing browser tool's workspace-root configuration; no screenshot-based visual signoff is claimed.

Lavish session returned HTTP 200 locally; existing tailnet HTTPS mapping for port 4387 confirmed. Required M5 access check attempted twice but SSH timed out, so end-to-end laptop reachability is unverified.
