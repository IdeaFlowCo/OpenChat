# Message-to-person memory — first design exploration

Status: proposal, not implementation. October 9, 2026. Tracking: OpenChat-poh4.

Open `.lavish/message-memory/index.html` for the portable interactive concept.
Lavish review: https://m4-mini.tailb2a35c.ts.net:4387/session/ed3737bf08174057

## User intent

Start with an always-on Mac observing iMessage. A configured reaction or hashtag reply captures knowledge about a person. Explore a familiar full messaging client for mobile and desktop, WhatsApp, separate versus combined streams, standalone versus OpenChat packaging, and a possible relationship to Notestream Vision.

Confirmed clarification: captured material can be structured contact information, private knowledge about a person, or a per-chat stream entry. Full Apple Contacts-equivalent contact-card capability inside OpenChat is part of the product vision. Private first, with explicit selective sharing later. Hashtag replies are literal replies to a source message; any topic hashtag (e.g. #longevity) can capture the parent message.

## Recommended shape

Begin with a small companion, then optionally expand to a messaging client. Reuse OpenChat’s contact, person-note, and chat-stream concepts as a shared capture model. A source capture can project into a structured contact field and/or a scoped stream entry without losing provenance. Share the record/API across surfaces rather than creating an independent store to migrate later. No new product name or repository is needed at this stage.

One person, separate network conversations by default, an optional combined chronological history. All-history messages retain channel labels; the composer explicitly names the destination and preserves it when the reader switches tabs. Groups remain separate threads. Identity links are reversible and uncertain matches require review.

The desktop client has an inbox, central conversation, and optional private memory panel. On phone the conversation fills the screen, and a visible Memory button opens the same information. Familiarity is the design target; full iMessage capability parity has not been established.

## Capture semantics

- Owner's configured reaction (provisional example: pin emoji) or literal reply containing a hashtag, including free-form topics such as #longevity. Both are visible to the other party in Apple Messages. Verify custom emoji event support on the target Mac before committing to that trigger.
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


## October 9 clarification — OpenChat-9odn

The revised interactive artifact leads with three literal hashtag-reply examples: address → contact field, Dad’s longevity link → chat stream, communication preference → private person note. The original client exploration remains below it.

### Two independent axes

Destination is contact info, person knowledge, or a particular chat’s stream. Audience is Only you, selected people/chat, or an owner-controlled shared profile. Do not derive audience from destination or from the fact that the source was sent in a chat. Existing OpenChat reply-tag captures can be shared; imported iMessage captures need an explicit private audience and must not silently inherit that default.

Contact scope: names/nicknames/pronunciation, multiple labeled phones/emails/postal addresses, company/role, URLs/social handles, birthdays/dates, relationships, photos, freeform notes, custom labels, search, reversible identity links, duplicate review and vCard import/export. This is a target capability list, not a claim of current parity. Device Contacts synchronization is a separate integration with stable IDs, conflict handling and explicit direction, not an automatic consequence of saving a field in OpenChat.

Private person knowledge: interests, preferences, goals, projects, family context, introductions and follow-up context. Preserve source/date and avoid interpreting shared content as a belief, diagnosis or endorsement.

Per-chat stream: links, articles, papers, videos, ideas, recommendations, decisions, questions and commitments. Dad/Jacob longevity links belong here with #longevity and source-message links. A topic collection across chats can be an additional owner-only view; it must not broaden the original audiences. Keep private annotations separate from shared resource revisions.

Exact hashtag grammar remains a proposal: any topic tag captures the replied-to source into the chat stream; #contact/#address may route structured fields and #remember may route person notes. Preserve existing inline tag semantics. Extract into an empty unambiguous field with Undo; review conflicting old/new values, uncertain subjects and labels. Publication to another person’s owner-controlled profile requires their own update/acceptance path; the observer can instead share a selected note or contact detail in their own name.

### Existing capability evidence, read in this revision

- apps/server/src/services/extractThoughtsFromMessage.ts: any free-form hashtag becomes a Thought; replyToId selects the parent content and source, viaMessageId records the triggering reply. Existing socket fanout includes the conversation’s shared feed. Missing-parent fallback currently differs from the stricter proposed external bridge behavior.
- docs/conversation-content.md: Context/Chat Stream share an audience-aware collection; owner-private scoped entries and separate Share & pin review already exist. Current delegated/connector reads exclude private rows; do not assume the external bridge can use existing agent routes to expose them without an explicit scoped API design.
- docs/surface-map.md: private profile note capture, saved people without accounts, and contact/profile doors are implemented.
- apps/server/src/services/addMeCard.ts and addMeCardVcard.ts: public stranger projection is intentionally limited; the current vCard output does not establish full structured address-book parity. Private address-book information must not be added to this projection by default.

### Information and sharing recommendations

Addresses, personal phone/email, birthdays, family details and sensitive context start private. Public professional roles, websites, projects, asks/offers and chosen interests are suitable owner-controlled shared-profile candidates. Research links and recommendations are natural chat-sharing candidates. Commitments can carry explicit assignee/due date; reminders are separate opted-in behavior. Secrets such as passwords/recovery codes belong in a vault, outside this contact/stream model.

The single-note / multiple-view direction with Vision remains useful, extended with typed contact-field projections and independent conversation scope/audience. A structured address is not merely a prose note, though it retains the same source capture.


## Literal emoji reply — OpenChat-st58

Lavish feedback: “Can you also do an emoji reply, or no?”

Yes as proposed behavior: an exact configured emoji-only reply (e.g. 📌) with a resolvable parent saves that original message/link privately to the source chat stream. Distinguish this from a Tapback event and from a hashtag reply. Do not intercept arbitrary social emojis or guess a source for an unthreaded emoji. Normalize harmless surrounding whitespace/emoji presentation selectors, but do not interpret longer prose merely containing the emoji as a capture command. Topic hashtags add organization; explicit #address/contact instructions may request structured contact extraction. The generic emoji gesture does not automatically overwrite address-book fields.

The concept now includes an Emoji-only reply example beside the address, longevity and person-note examples. This is not an implementation of an iMessage connector; target Mac event and parent linkage remain verification work. Fable has been asked to review these choices as part of the whole vision.
