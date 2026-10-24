# Imported chat mirrors

An imported chat is a private, read-only copy of a chat from another network
(WhatsApp first) that one OpenChat account owner chose to bring in. It belongs
to that owner only. It is not an OpenChat conversation: nobody in it is
messaged, invited, notified or matched, and nothing in it is visible to anyone
but the owner and agents the owner has given a key.

Tracked in beads `OpenChat-061g`.

## What it is not

- **Not a live chat.** Imported messages live under their own graph labels
  (`OpenChatImported*`), never as `Conversation`/`Message` nodes. Socket
  rooms, push, unread counts, search, the OpenChat Agent, Context, matching,
  Stories and discovery read only `Conversation`/`Message`, so none of them can
  see or fan out an imported message. There is no send endpoint.
- **Not accounts.** A historical sender becomes an *imported participant* with
  a stable source key. No `User` node is created for them, and source
  membership never grants anyone access to anything.
- **Not a merge.** Two participants with the same name stay two participants.
  Participants are not linked to OpenChat accounts at all yet (see *Later:
  account claims*); nothing in an import can set a link.

## Ownership and authentication

Every route acts for the authenticated owner only: an OpenChat app session, or
an agent key that owner issued (`read` to look, `write` to import or change
anything). No id in a request can select another owner. Refusals, including
another owner's chat ids, answer `404` (never `403`; the app signs out on 403).
Two owners importing the same WhatsApp group get two separate private copies.
The shared Ideaflow connector, connector-delegated calls and embedded
(Unlinked) sessions are refused. The import body is parsed only after the
caller is authenticated, so an anonymous request never makes the server buffer
a large payload.
The owner's account must still exist: an import locks the owner's `User` node
first and answers `404 Account not found` when it is gone, so a token that
outlives a deleted account cannot recreate an archive.

## Import API

`PUT /api/imported-chats/import` — upsert one chat. Body up to 16 MB and
5,000 messages; send larger histories in several requests with the same
`source`. `?dryRun=1` validates and returns the same change summary without
writing anything, for review before the real import.

The whole request is validated first and applied atomically: any error rejects
the request with `400` and an `errors` list (`path`, `message`), and nothing is
written.

### Payload (schemaVersion 1)

```jsonc
{
  "schemaVersion": 1,
  "source": {
    "network": "whatsapp",                 // lowercase network id, [a-z0-9_-]{1,32}
    "accountKey": "owner-wa-account-key",  // stable key for the owner's own account on that network (an opaque hash is fine)
    "chatKey": "group-key",                // stable chat key on that network (e.g. a hash of the group JID)
    "chatType": "group",                   // "group" | "direct"
    "title": "Example group"               // display title as of this import
  },
  "coverage": {
    "asOf": "2026-10-23T18:00:00Z",        // when the source was read (required)
    "method": "whatsapp-native-db",         // how it was read, free text ≤ 80
    "earliestMessageAt": "2026-01-02T03:04:05Z", // optional; else derived from messages
    "latestMessageAt": "2026-10-22T09:00:00Z",   // optional; else derived
    "complete": false,                      // true only when the whole source history is included
    "note": "Media not imported.",          // optional, ≤ 500
    "sourceRowCounts": { "total": 18, "text": 5, "nonText": 13 } // optional: rows the source held for this chat (text = ordinary text messages; nonText = media, system, calls…), whatever was imported
  },
  "participants": [
    {
      "sourceKey": "p-1",                  // stable per source chat; never a phone number in clear unless you accept storing it
      "displayName": "Ada Example",        // optional; omit when unknown — never invent
      "nameSource": "push_name",           // "contact" (owner's contact) | "push_name" (name they set) | "profile" | "self_stated" (they gave it in a message) | "owner" | "unknown"
      "nameSourceMessageIds": [],           // required for "self_stated": the message(s) where they gave the name
      "membership": "current",              // optional: "current" | "former" | "unknown" (roster state as of coverage.asOf)
      "isOwner": false,                    // exactly the owner's own participant, if present
      "profileFacts": [                    // optional; statements evidenced in this chat only
        { "factKey": "role", "text": "Runs a soil-health lab", "sourceMessageIds": ["m-2"] }
      ]
    }
  ],
  "messages": [
    {
      "sourceMessageId": "m-1",            // required; dedupe key within the chat
      "senderKey": "p-1",                  // participant sourceKey; null only for kind "system"
      "sentAt": "2026-01-02T03:04:05Z",    // required, source timestamp
      "kind": "text",                      // "text" | "media" | "system" | "deleted"
      "text": "Hello",                     // ≤ 20,000 chars; optional for media/system; must be absent for deleted
      "mediaType": null,                   // optional label for media ("image", "audio", …); media bytes are not imported
      "editedAt": null,                    // set when the source shows the message was edited
      "replyToSourceMessageId": null       // optional
    }
  ],
  "asks": [
    {
      "askKey": "ask-1",                    // stable importer key; reimports update the same ask
      "subjectKey": "p-1",                  // whose need it is, or null when they are not in the chat…
      "subjectLabel": null,                 // …then a short label as the reporter named them ("Cy"), ≤ 120
      "reporterKey": "p-1",                 // who said it (may differ: "Bo is looking for …")
      "text": "Looking for a co-founder with lab experience",
      "sourceMessageIds": ["m-2"],          // at least one; the messages that state it
      "sourceStatus": "open",               // "open" | "resolved" | "withdrawn" | "needs_review" | "unknown"
      "statusSourceMessageIds": []          // messages that show it was resolved/withdrawn, if any
    }
  ]
}
```

### Validation rules

- Every message has a `sourceMessageId`, an ISO `sentAt`, and a `senderKey`
  naming a participant in this payload or already imported (`system` messages
  may have `null`).
- Every `sourceMessageIds` / `statusSourceMessageIds` entry names a message in
  this payload or already imported into this chat. An ask or profile fact with
  no source message is rejected.
- `reporterKey` names a participant in this payload or already imported.
  `subjectKey` does too, or is `null` with a `subjectLabel` for someone the
  reporter mentioned who is not in the chat (never guessed to be a participant).
- Each ask's `reporterKey` is the sender of at least one of its
  `sourceMessageIds` (asks on someone else's behalf name that person as the
  subject; the reporter is still whoever wrote the message).
- A `self_stated` name cites at least one message sent by that participant.
- Attribution checks use the effective sender: the stored (immutable) sender
  for a message already imported, even if this payload disagrees, otherwise
  the payload's sender.
- At most one participant has `isOwner: true`.
- Keys are 1–200 characters. Duplicate keys within one request are rejected.

### Reimport and edits

The dedupe key is owner + network + account + chat + `sourceMessageId`.

Imports only move forward: a payload whose `coverage.asOf` is earlier than the
chat's saved `asOf` is rejected with `409` (`currentAsOf` in the body) and
nothing is written, so an old snapshot can never roll back newer text, names
or asks. Equal `asOf` is allowed, for chunked imports of one snapshot.

- A message's sender, `sentAt` and source id are immutable. A reimport that
  disagrees is reported under `conflicts` and that message is left unchanged.
- Text follows the source. When the text changes, the message keeps the text
  first imported as `originalText` and records `editedAt` (the source's, or
  the import time when the source gave none) and `revision`. A message the
  source already marks edited (`editedAt`) shows as edited from its first
  import, without an original.
- `kind: "deleted"` clears the stored text (the sender removed it) and records
  `deletedAtSource`; a later import cannot restore text over a deletion.
- Participants keep their first `sourceKey`; `displayName`/`nameSource`/
  `nameSourceMessageIds` follow the latest import that supplies a name, and
  `membership` the latest import that supplies it. An import that omits them
  never clears them.
- Each new participant gets the next stable number in the chat (`ordinal`,
  payload order), used only for unnamed labels.
- Asks: `sourceStatus`, text and evidence follow the latest import. The
  owner's own status (`ownerStatus`, set in the app or by a `write` key) is
  never overwritten by a reimport. An ask or fact that a later import does
  not list, although that import re-sends all of its source messages, is
  marked `stale: true` (shown as *Not in latest import*), never deleted.
  Listing it again clears `stale`.
- Coverage widens: `earliestMessageAt` is the minimum and `latestMessageAt`
  the maximum seen across imports; `asOf` is the latest import's.

### Response

`201` when the chat was created, `200` otherwise (including dry runs).

```jsonc
{
  "dryRun": false,
  "chatId": "…",
  "created": true,
  "counts": {
    "participants": { "created": 3, "updated": 0, "unchanged": 0 },
    "messages":     { "created": 5, "edited": 0, "deleted": 0, "unchanged": 0 },
    "asks":         { "created": 1, "updated": 0, "unchanged": 0, "markedStale": 0 },
    "profileFacts": { "created": 1, "updated": 0, "unchanged": 0, "markedStale": 0 }
  },
  "conflicts": [ { "sourceMessageId": "m-1", "field": "sentAt", "message": "…" } ]
}
```

## Read and owner routes

| Route | Scope | Returns |
|---|---|---|
| `GET /api/imported-chats` | read | The owner's imported chats with coverage and counts. |
| `GET /api/imported-chats/:chatId` | read | One chat with coverage. |
| `GET /api/imported-chats/:chatId/messages?before=&limit=` | read | Messages newest first, with sender participant id. |
| `GET /api/imported-chats/:chatId/people` | read | Participants with message counts, first/last seen, link state. |
| `GET /api/imported-chats/:chatId/people/:participantId` | read | Mini-profile: name and its source, facts with source messages, asks, recent messages. |
| `GET /api/imported-chats/:chatId/asks` | read | Asks with subject, reporter, source messages and statuses. |
| `PATCH /api/imported-chats/:chatId/asks/:askId` | write | `{ "ownerStatus": "open" \| "resolved" \| "withdrawn" \| "needs_review" \| null }` |
| `DELETE /api/imported-chats/:chatId` | write | Removes the mirror and everything imported into it. |

## Display honesty

- A participant without a name is **Unknown participant 3** (their stable
  number in the chat); source keys such as WhatsApp JIDs are never returned by
  the API. No bio is ever invented.
- A name shows where it came from (*Name they set on the network*, *Name from
  your contacts*, *Name from their own message* with that message quoted).
- Coverage shows the source's own row count (*18 source rows · 5 text, 13
  other*) so a partial import never reads as the whole chat.
- Every participant shows **Not linked to an OpenChat account**. That says
  nothing about whether they use OpenChat.
- Every profile fact and ask shows the messages it came from, who said it, and
  the source coverage (`asOf`, earliest/latest, complete or partial).
- The chat header says **WhatsApp mirror · read-only** and the coverage line.

## In the app

Chats shows an **Imported chats** row (desktop: a sidebar link) once the owner
has one; nobody else sees an empty door. Chats › Imported chats › a chat opens
three sections:

- **Conversation** — a transcript, not chat bubbles, under the provenance
  strip. No composer. Edited messages say so and can show the original;
  deleted ones say *Deleted by the sender*; media says it was not imported.
- **People** — everyone in the chat, including unnamed participants, with
  message counts and account state. A name opens the person's small profile:
  name source, facts and asks with their source messages, recent messages.
- **Asks** — each ask with whose need it is (or *Cy · not in this chat*), who
  said it, the quoted source messages, and the owner's status chips. *Use
  source status* clears the owner's choice.

Linking a participant to an OpenChat account is not offered yet.

## Account lifecycle

Account export includes the owner's imported chats (`importedChats`, all
time, so citations stay intact). Deleting the account deletes them.

## Later: account claims

A person who later joins OpenChat cannot claim an imported participant by
themselves, and a claim — when built — must be verified (for example by
proving control of the same source-network identity). A verified claim would
let the owner see "this is now <account>". It does **not** give that person
access to the owner's archive, does not rewrite the attribution of imported
messages, asks or facts, and does not make imported messages live. Even an
owner-confirmed link would have to follow OpenChat's existing discoverability
and blocking rules before it shows any account's name; until that is designed,
no linking is offered.

The proposed [direct-chat claim and history-continuity contract](imported-chat-claim-continuity.md)
separates verified identity linking from explicit, mutually accepted history
sharing. It is a design document, not an implemented claim or migration API.

## Synthetic fixture

`apps/server/test/fixtures/importedChat.synthetic.json` is an entirely
invented chat used by the tests. Real chat data never goes in git.
