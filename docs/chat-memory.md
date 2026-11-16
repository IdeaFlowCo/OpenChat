# Private Chat memory (initial slice)

Chats → Imported chats → a chat → Memory. The Conversation transcript has
**Save this message**. Suggestions are owner-only and searchable. **View source**
reads the exact imported source message, without entering a live conversation.

`GET /api/imported-chats/:chatId/memory` scans up to the latest 2,000 imported
messages and explicitly reports truncation. It returns deterministic candidates:
explicit #hashtags, links, street-address/map candidates, dates/times, booking language, media
placeholders, to-do language and decision language. These are source words, not
verified facts. It performs no external requests, metadata scraping, geocoding,
LLM calls, media downloads, WhatsApp calls, sockets or read receipts. GET does
not save candidates. Repeated normalized URLs and equal category/text items
retain all source message citations. Query parameters that identify a booking
remain; common tracking parameters are removed.

`POST /api/imported-chats/:chatId/memory/saved` accepts only `sourceMessageId`.
It checks ownership and source existence, then uses the existing private graph
project and note services. An owner-fenced pointer on the imported chat binds the
project's immutable ID; names and kinds remain editable. Notes contain only a
versioned reference, not a copy of source text, and existing note deduplication
makes retries idempotent. Deleting a project removes its saves; loading still
shows automatic suggestions, and an explicit save creates/rebinds storage.
The existing note limit (200 per subject) applies. Nothing is published, matched,
added to another person's account, or written back to WhatsApp.

`GET /api/imported-chats/:chatId/messages/:sourceMessageId` returns an exact
owner-fenced citation. Shared connector, delegated connector and embedded
sessions are denied by the imported-chats router. Agent keys require read scope
for GET and write scope for saving. Responses have Cache-Control: no-store.

Remaining product work: live/scoped source adapter, link titles and preview
assets with an approved privacy-preserving fetch policy, imported media bytes,
better place/date/entity recognition and correction, semantic task/decision
status, automatic scan pagination/background indexing, durable automatic
extraction records, and an richer source integration. The initial UI
shows raw map URLs and URL-derived link labels rather than fetched previews.

Only synthetic fixtures belong in source, tests, PRs and screenshots for review.
A real owner demo requires separately verified source coverage and owner identity;
report category counts rather than private chat contents.

Chat memory applies to any imported direct or group chat, regardless of topic. Explicit Unicode letter/number/underscore hashtags are captured separately from suggestions, deduped case-insensitively with every source citation. URL fragments are excluded. No tags is a normal empty state, not an invitation to invent tags. The legacy internal v1 note marker and imported-chat storage pointer remain compatible. This slice still operates on imported mirrors; it does not yet establish browsing of arbitrary live Beeper chats.

Memory separates Tagged, Suggested and Saved. Suggestions can be saved or dismissed; saved references can be removed. Dismissals and saves persist as distinct owner-private note markers; neither changes source content or implies endorsement of a tag author. Removed saves leave unrelated project notes intact.
