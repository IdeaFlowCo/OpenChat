# Private graph

A person's own notes and links about the people they know. Everything here
belongs to one owner and is shown only to that owner: the person a note or
link is about never sees it, and nothing in it is read by search, matching,
Stories or anyone else's profile.

## What it holds

Storage is the people overlay, a layout owned by Noos and kept in the graph
database OpenChat shares with it. OpenChat is one view of it; Unlinked shows the same owner the same notes,
read-only, on person and contact pages (Unlinked `docs/private-context.md`).

| Stored as | Meaning |
|---|---|
| `OverlayEntity` | A person, company, idea, project or topic the owner keeps something about, with an optional one-line `description`. Importance and catch-up cadence sit on it. One made by name is unique per owner, kind and name. |
| `OverlayRef` | How an app points at an entity. A person on OpenChat is the entity named by `openchat:user:<id>`; an entity can carry refs from several apps. |
| `OverlayNote` | A note about an entity, with its provenance. |
| `OVERLAY_LINK` | A real relationship between two of the owner's entities, with the relation in the owner's own words ("knows", "works at", "interested in"), a `relationType`, optional `since`, `until` and `context`, and its provenance. |

Every node and link carries the owner's key and every query is anchored on it.
The key is derived from the owner's Ideaflow sign-in when they have one, so the
overlay is theirs across Ideaflow apps; an account without one is keyed by its
OpenChat id, and what it wrote moves to the Ideaflow key when the sign-in is
linked.

**One owner of the rules.** The vendored files listed in
[`NOOS_SOURCE.json`](../apps/server/src/services/overlay/NOOS_SOURCE.json)
are byte-for-byte copies of Noos `src/overlay/`, which alone implements the
overlay's semantics, including contact sources, People state, publications and
blurbs. That manifest owns the source commit and each file's SHA-256;
`apps/server/test/overlayVendor.test.ts` checks for local drift. Change the files
in Noos first, then run
`node scripts/vendor-noos-overlay.mjs <path-to-noos-checkout> [ref]`.
Without `ref` the source overlay must be clean; an explicit ref reads immutable
Git blobs. Do not patch the vendored files locally.
`services/privateGraph.ts` is OpenChat's side: who may be written about (no
bots, no blocks, not yourself), confirming Unlinked profile refs through the
owner's grant, who is writing (provenance), and the response shapes below.
`services/privateNoteReview.ts` writes its notes and links through the store's
transaction forms, so they follow the same rules.

Catch-up cadence is either fixed (the same gap each time) or expanding (the gap
grows by 1.6 after each catch-up, up to a year). `nextDueAt` counts from the
last catch-up, or from when the cadence was set.

## API

All routes are under `/api/private` and act for the authenticated owner; no id
in a request can select another owner. A session has full access. An agent key
needs `read` to look and `write` to change. A missing, blocked, bot or
foreign-owned target answers 404; the client signs a person out on 403, so
these routes never return it.

| Route | Purpose |
|---|---|
| `GET /people/:userId` | Card, notes and links for a person |
| `PATCH /people/:userId` | `important`, `cadenceDays` (or `null`), `cadenceMode`, `contactedNow: true` |
| `POST /people/:userId/notes`, `POST /things/:thingId/notes` | Add a note |
| `PATCH /notes/:noteId`, `DELETE /notes/:noteId` | Edit or delete a note |
| `POST /people/:userId/links`, `POST /things/:thingId/links` | `{ relation, to, relationType?, since?, until?, context? }` where `to` is `{kind:'user', id}` or `{kind:'person'\|'company'\|'idea'\|'project'\|'topic', id \| name}`; a name creates or reuses the saved thing. Repeating an existing link returns it unchanged |
| `PATCH /links/:linkId` | Any of `{ relation, relationType, assertion, since, until, context }`, see [Editing a relation](#editing-a-relation) |
| `DELETE /links/:linkId` | Remove a link |
| `GET /search?q=&relationType=&kind=&limit=` | Search saved things, OpenChat people and Unlinked people the owner wrote about (by name, description or note text; `matched` says which), and links by relation text, context, either end's name or `relationType`. At least one filter; at most 50 of each; `truncated` when more matched. Blocked people are left out |
| `GET /neighbourhood?subjectKind=user\|thing\|unlinked&subjectId=&depth=1\|2` | A subject and everything one or two links away, with those links (`from`, `to`). Never creates anything; at most 100 nodes and 200 links. Blocked people are left out |
| `GET /things?q=&kind=&after=&limit=&details=` | A page of saved things, matching `total` and `nextCursor`; see [Pagination](#pagination) |
| `GET /things/:thingId` | One saved thing with its card, optional People state, contact sources, notes and links |
| `GET /things/:thingId/contact-state` | Owner-only card, sources and People state, including OpenChat-backed entities; see [readback](#verified-contact-actors-and-profile-independent-readback) |
| `POST /contact-sources`, `POST /contact-source-batches` | Import one source card or `{cards: [...]}`; see [Contact sources and People state](#contact-sources-and-people-state) |
| `PUT /things/:thingId/people-state` | Versioned state replacement with an operation receipt; see [Contact sources and People state](#contact-sources-and-people-state) |
| `PATCH /things/:thingId` | `{ name?, description?, kind? }`: rename, describe (`null` or `''` clears) or change the kind of a saved thing (an idea that became a project). Someone on Unlinked keeps their kind (409); an OpenChat person's card answers 404 |
| `DELETE /things/:thingId` | Delete (undo) a saved thing: the entity, its notes, its links in both directions, refs, contact sources and People-state operation receipts, plus OpenChat's note reviews and asks about it, in one transaction. Answers `{deleted: true, id, notesRemoved, linksRemoved}`; a missing, already-deleted or foreign id, or an OpenChat person's card, answers 404 |
| `POST /things`, `POST /things/resolve` | `{kind, name, description?}` / `{kind, name, description?, createNew?, clientRequestId?}`: find or save by name under the no-merge rules below. A description is stored on a new thing and fills an existing thing's blank one; it never replaces one |
| `GET /due` | People whose catch-up date has passed |
| `GET /links?q=` | Every link the owner recorded, newest first, filtered by a name or relation |
| `GET /unlinked-people/:profileId` | Card, notes and links for an Unlinked profile (never creates, never calls Unlinked) |
| `POST /unlinked-people/:profileId/notes`, `POST /unlinked-people/:profileId/links` | Note or link about an Unlinked profile |

### Pagination

`GET /things` and `oc_list_private_things` return
`{things, total, nextCursor}`. Pass `nextCursor` unchanged as `after` until it
is `null`; omitting `after` starts a new traversal. `limit` is 1–100, default
100. Pages use immutable entity-id order, not name order. Cursors are bound to
the owner and normalized name/kind filters; changing that scope returns 400.
`total` counts all matching saved things, excluding OpenChat account entities,
asks and blurbs, rather than just this page. Traversal continues beyond 5,000
results. Concurrent graph edits can change membership and totals between pages;
this is not a frozen snapshot. Reconcile missing records only after reaching
`nextCursor: null`; an interrupted traversal is incomplete. Creation capacity
is governed by the canonical
[`LIMITS`](../apps/server/src/services/overlay/contract.ts), independently of
the page size.

Every result includes its canonical `card` and `peopleState` when present.
`details: true` (REST `details=true`) also returns `notes`, `links` and
`contactSources`, fetched in batches for the page. `GET /things/:thingId`
returns those details for one entity. The same paging arguments and response
are available through the shared connector and agent-key MCP server.

### Contact sources and People state

`POST /contact-sources` (`oc_import_contact_source`) takes
`{source, sourceId, name, data, entityId?}`. `data` is a JSON object with
`schemaVersion: 1`; supported and future fields survive without alias or
provenance rewriting. The exact `source` and `sourceId` strings identify the
owner's source card, including significant whitespace. A retry reuses its
entity; changed source data updates the source card, never the entity's
canonical name. A new source creates a separate person even when names match.
To attach it to an existing entity, supply an explicitly verified,
owner-scoped `entityId`; rebinding an existing source to another entity returns
409 `contact_identity_conflict`. The response is `{entity, created, unchanged}`.

`POST /contact-source-batches` (`oc_import_contact_sources`) takes 1–25 cards.
Each card has its own transaction; the response's `results` contains one
indexed receipt per input, either `{index, id, created, unchanged}` or
`{index, error}`. Inspect every receipt: HTTP success does not mean every card
was imported. Retry failed cards with their original source identifiers.

`PUT /things/:thingId/people-state` (`oc_save_people_state`, with `thingId` as
a tool argument) takes `{operationId, expectedRevision, payload}`. The payload
is a complete replacement JSON object with `schemaVersion: 1`, not a patch.
Use `expectedRevision: 0` when no state exists. A successful write returns
`{schemaVersion, revision, payload, updatedAt, author, source, assertion, actorId}`.
An optional `payload.card` also updates canonical importance and cadence;
its exact validation contract is owned by
[`stateCard`](../apps/server/src/services/overlay/contacts.ts).

An exact replay for the same owner, entity, operation, authenticated app and
actor, revision and payload returns the original receipt. Reusing that
operation id with different content or attribution returns 409
`operation_id_reused`; a stale revision returns 409 `state_conflict`. Preserve
the local payload for reconciliation, read the current state through
[`oc_get_contact_state`](#verified-contact-actors-and-profile-independent-readback),
then use a new operation id for the revised write. A legacy agent receipt that
cannot establish stable actor identity returns 409
`legacy_operation_requires_reconciliation`; read back and reconcile before
attempting a new write. A verified label rename does not change the actor or
invalidate an otherwise exact replay. Existing `PATCH /people/:userId` card
writes also advance People state, preserving other payload fields and recording
the authenticated writer, so an older People-state revision cannot overwrite
them silently.

Source/state provenance comes from authentication, never opaque JSON fields.
Neither route changes owner access or Unlinked grants. Each source `data` or
state `payload` is limited to 262,144 serialized UTF-8 bytes. HTTP bodies allow
1 MiB for single imports/state writes and 7 MiB for batches; the connector MCP
envelope allows 7 MiB. These do not raise limits on unrelated REST routes.

### Verified contact actors and profile-independent readback

Source-card imports, People-state saves and legacy person-card PATCHes carry a
stable verified actor ID separately from the readable `author` label. Connector
requests use the hub's signed
[`actor_id` claim](ideaflow-unified-connector.md#service-configuration); direct
OpenChat keys use their verified key ID. Missing connector identity rejects
these writes before the store. Labels and request bodies cannot establish
actor identity. The canonical source pin is owned by
[`NOOS_SOURCE.json`](../apps/server/src/services/overlay/NOOS_SOURCE.json).

`GET /api/private/things/:thingId/contact-state` and `oc_get_contact_state` return
only the owner's `thingId`, canonical `card`, `contactSources` and optional
`peopleState`, including on OpenChat-backed entities. They do not expose the
associated account profile or widen its visibility. The existing saved-thing
list and detail exclusions remain. Link browsing uses the canonical lightweight
projection so it does not load unrelated source JSON or People payloads.

## People from Unlinked

An Unlinked person is one of two things, and both are confirmed with the
owner's own read-only Unlinked grant (the identity-scoped provisioning OpenChat
already uses for Unlinked search) through Unlinked's owner-scoped
`POST /api/agent/v1/contacts/lookup` (`unlinked_lookup_contact`), which only
ever answers the owner's own imports and published profiles:

- **A published profile** is the overlay entity named by
  `unlinked:person:<profileId>`, the ref Unlinked itself uses. Only an id
  Unlinked's published People index answers for becomes a person here, under
  the canonical id when a profile was merged. Once stored, writes and reads by
  that profile id use the ref and do not call Unlinked.
- **An imported LinkedIn contact** (an `owner_import` row from
  `unlinked_list_connections`) is named by `linkedin:in:<sha256 of the canonical
  slug>` (Noos `docs/PEOPLE_OVERLAY.md`, "Imported LinkedIn contacts"). The
  agent passes the connection id or the contact's `linkedin.com/in/` address;
  Unlinked returns the hash, so no LinkedIn address is stored in the overlay.
  The ref survives re-import (Unlinked's connection ids may change), and
  another owner's import of the same person is that owner's own entity.

`toKind 'unlinked'` (and `subjectKind 'unlinked'`, and
`GET /api/private/unlinked-people/:id`) accepts either: a 64-hex id is an owner
connection id, a LinkedIn address is looked up by address, anything else is a
published profile id. When the same person is both (imported, and published
on Unlinked), the one entity carries both refs (`ensureRefs` in the vendored
store): imported first and published later, or the reverse, still reach one
entity. A published-profile entity written before this change gains the
LinkedIn ref the next time the contact is written by connection id. A contact
with neither a LinkedIn address nor a published profile is refused (409); save
them by name. People saved by name only stay separate unless the owner links
them explicitly — nothing is merged by name.

Reads show who an end is: `unlinkedProfileId` for a published profile,
`linkedinRefHash` for an imported contact plus `unlinkedConnectionId` when
Unlinked names it (one batched lookup per read; omitted when Unlinked cannot
answer). `oc_get_unlinked_person_private` returns `profileId`, `connectionId`
and `linkedinRefHash`. Reading by a connection id or address asks Unlinked
which contact it is, read-only; reading by a published profile id does not.

## Names, retries and undo

A link to a saved thing by name reuses it only when exactly one of the owner's
entities of that kind has that name and it is a saved-by-name thing. When the
name is shared (two people called Alex, or an OpenChat contact with the same
name), the call answers 409 with `code: "ambiguous_name"` and `candidates`, each
with the `to` to use; nothing is created. `createNew: true` with a
`clientRequestId` keeps a deliberately different person apart (overlay ref
`openchat:private:<hash>`); repeating that request returns the same entity.
The same subject, relation and target is always one link, and the same note text
on a card is one note, so retried calls do not duplicate. Deleting a note or link
is the undo; deleting a saved thing (`DELETE /things/:thingId`,
`oc_delete_private_thing`) is the undo for saving one, and takes its notes and
links with it. Deleting again answers 404.

## Provenance and relation types

Every note and link written since 2026-10-09 records who wrote it and how,
derived from how the request authenticated (never from its body):

| Writer | `author` | `source` |
|---|---|---|
| The owner, signed in to OpenChat | `owner` | `app` |
| An agent through the shared Ideaflow connector | `agent:<client name the agent registered>` | `connector` |
| An agent with one of the owner's OpenChat keys | `agent:<key's agent name, else key name>` | `direct-key` |
| A note-review suggestion the owner (or an agent) applied | the applier | `suggestion` |

`assertion` is `stated`, or `inferred` for applied suggestions and when an agent
passes `assertion: "inferred"`. Notes and links written earlier have no
provenance and read back with `author`, `source` and `assertion` set to `null`.
A repeated note or link keeps its first provenance.

Links also carry `relationType`, a query facet over the owner's words: `knows`,
`family`, `worked_with`, `works_at`, `works_on`, `attended`, `interested_in`,
`part_of`, `about` or `related` (Noos `docs/PEOPLE_OVERLAY.md` has the table).
A caller may name it; otherwise it is derived from the words *and* what the
link connects, so `knows`, `family` and `worked_with` only join two people and
an idea "connected to" a person is `related`, the generic fallback. `related`
replaced `other` on 2026-10-10: stored `other` reads back as `related` and
`other` is still accepted as input. Stored types are never rewritten; links
stored with no type (before 2026-10-09) are typed from their words, as before.

### Editing a relation

`PATCH /links/:linkId` (`oc_update_private_link`) takes any of `relation`,
`relationType`, `assertion`, `since`, `until` and `context`; `null` (or `''`
from an agent tool) clears `since`, `until` or `context`, and
`relationType: null` derives it again.

- A new `relation` ("sister of" to "cousin of") changes the relation, its
  `relationType` and the link's identity together and records the editor's
  provenance. If the owner already has that exact link, the two become one and
  `{ link, merged: true }` returns the existing one, with the rest of the edit
  applied to it.
- Anything else is an in-place edit (for example `stated` to `inferred`): the
  original `author` and `source` stay, and `updatedAt` and `updatedBy` (the
  editor) record the change.

`since` and `until` are free date text (20 characters or fewer, "2019",
"2024-03"); `context` is one line of 280 or fewer ("met at AGI House
hackathon"). All three read back as `null` on links without them.

### Kinds and descriptions

Saved things are `person`, `company` (also schools and organisations),
`idea`, `project` or `topic` (since 2026-10-10: a thing in the world people and
projects are about, such as ADHD or coherence). Each may carry a one-line
`description` (280 characters or fewer) instead of a separate node for what it
is; search matches it. A saved thing's kind can change (an idea becomes a
project) unless it names someone on Unlinked.

Account export includes the owner's private graph under `privateGraph`:
entities with People state, notes and links, plus contact sources and blurb state
when present. Account deletion removes everything the person kept, under either
identity that can name them, and removes other owners' entities that knew them
only as an OpenChat account. An entity with an imported
contact source survives removal of that account ref; its owner-private source
record is independent of the deleted account.

## Asks

Since 2026-11-03 (OpenChat-2fsy.1) asks have one home: the overlay's `ask`
kind (Noos `docs/PEOPLE_OVERLAY.md`, "Asks"). Every person is implicitly a
gestalt box, so an ask someone posts anywhere is also theirs. As in the
Gestalt Box model and WIT's "by me / to me" personal tracker, three facts stay
separate:

- **who cares**: `author`, always set. It is `self` (the owner) or an OpenChat person, an Unlinked person, or a saved person, company, project or idea. It is fixed.
- **who acts**: `carrier`, optional. It is `self` or a person or company. Handing an ask over sets it.
- **where it was placed**: `placements`, beyond the author's own box. It can be `self` (the owner's stream: addressed to them), a person or saved thing, or a conversation the owner is in.

`fromMe` and `forMe` (on my stream, or I carry it) follow from these.
`direction` filters by `from_me`, `for_me` or `from_others`, and
`aboutKind` + `aboutId` filters by any ask a person or thing cares about,
carries or is placed on.

Each ask also has a `horizon` (`event`/`short`/`medium`/`evergreen`: 7/14/60/90 days to `recheckAfter`), a `status` (`open`, `fulfilled`, `withdrawn`, `stale`), an `exposure` (`only_me` by default) and optional `evidence`. Record provenance is `recordedBy`/`recordedVia`/`assertion`.

Only the owner ever sees an ask: `exposure` records whom they mean it for and widens nothing yet.

The same author and text is one ask. An author's card lists their asks as `asks` links. Deleting a saved person deletes the asks they authored, clears them as carrier and drops them from placements.

| Route | Does |
|---|---|
| `GET /api/private/asks?direction=from_me\|for_me\|from_others&aboutKind=&aboutId=&status=&q=&needsRecheck=&limit=` | Open and stale asks first, by recheck date; `status` one value, a comma list or `all`. `asker=self\|others` still works (earlier clients). |
| `POST /api/private/asks` `{author, text, carrier?, placements?, horizon?, recheckAfter?, status?, exposure?, exposureConversationId?, evidence?}` | Save; 201 created, 200 existing. `author`/`carrier` are `'self'` or `{kind: user\|thing\|unlinked, id}`; a placement is one of those or `{kind: 'conversation', id}`. `this_chat` and conversation placements need a conversation the owner is in. (`asker` is read as `author`.) |
| `GET /api/private/asks/:id`, `PATCH /api/private/asks/:id`, `DELETE /api/private/asks/:id` | Read, edit (`carrier` hands over or, `null`, takes back; `placements` replaces; `recheckedNow: true` records a recheck; the author never changes), forget. PATCH also takes the card's old statuses `active`/`paused`/`closed` (open/stale/withdrawn). |

Standing asks captured on a private card, and asks a note review extracts,
are saved as overlay asks by that card's subject (a topic's become the
owner's own, linked `is about`); their evidence names the source note and
never copies it. `scripts/migrate-asks-to-overlay.mjs` (dry run unless
`--apply`) moves the earlier `OpenChatPrivateAsk` records and the friends'-asks
monitor's `[friend-ask v1]` notes into overlay asks, keeping both sources, and
must run right after the release that ships this.

The **Asks** tab opens with **People's asks · only you see these**, by
direction:
- **For you**: someone else's asks placed on your stream or carried by you.
- **Friends' asks**: each one names who cares and links to their card.
- **Your asks**: your own, with a field to add one.

Each row shows who carries the ask and where it was placed. The actions are Still open, I'll carry it, Fulfilled and Withdrawn, and a toggle shows closed asks. Agent tools: `oc_save_ask`, `oc_list_asks`, `oc_update_ask`,
`oc_delete_ask` (connector and agent-key MCP server).

## Lists

Since 2026-11-05 (Noos #105) a saved thing can be a `list`: an owner-private
collection of people, such as investors to contact. A list is a saved thing
like any other (rename, describe, delete; edits keep its id, refs and kind),
but its kind is fixed: a list stays a list and nothing else becomes one (409),
because its members are its outgoing `contains` links to people. Lists are not
unique by name: an imported list (Unlinked's CSV path names it with an
app-scoped ref) can share a name with another list, and a name can resolve to
`ambiguous_name` even when only one list has it, so address lists by id.
Membership is the owner's own bookkeeping. It is not evidence that they know
the person, it is never shown to the member or anyone else, and nobody is
notified.

Removing a member deletes that one `contains` link everywhere the owner looks.
A membership can be shared by several import receipts, so removal is a graph
edit, not the withdrawal of one import's contribution. There is no suppression
tombstone: a later or different import, later rows of a resumed import that
name the same person, or a retried write whose receipt was never saved can add
them back. A row an import already receipted is not replayed, so its removed
membership stays removed on an exact resume. Once an import has recorded its
list's id, deleting the list makes the unfinished resume fail (`not_found`)
without recreating it (a row in flight may leave the person and notes written),
and renaming it keeps the id (the import's recorded name stays historical).
Before that id is recorded, a retried import can recreate a deleted list or
restore its original name. Edits therefore do not win over a pending import;
making removal win would need a shared Noos suppression or cancellation
contract that the importer checks, not an OpenChat-only marker. Import receipts
live in Unlinked's import records and record original outcomes, not live
membership; OpenChat never rewrites them.

| Route | Does |
|---|---|
| `GET /api/private/lists/:id/members?after=&limit=` | One page of members (oldest link first), each with its `linkId`. The pages come from the overlay's owner-bound link pages: pass `nextCursor` back unchanged as `after`. A page can hold fewer than `limit` members, because other links on the list and people blocked either way are skipped; `nextCursor` is null only at the end. A cursor from another list or owner is 400. |
| `POST /api/private/lists/:id/members` `{kind: user\|unlinked\|person, id \| name, createNew?, clientRequestId?}` | Add an OpenChat person, an Unlinked person or a saved person (names never merge). Someone already on the list returns the existing membership. |
| `DELETE /api/private/lists/:id/members/:linkId` | Remove that membership only; the person's card stays. Anything that is not a `contains` link of the owner's list is 404. |

Agent tools: `oc_list_members` (read), `oc_add_list_member` and `oc_remove_list_member` (write), on the connector and the agent-key MCP server. `oc_save_private_thing` and the other thing tools take kind `list`. Note reviews never propose lists. A list's page in the app shows **Members · only you see this list**, one page at a time, with Remove and an add-by-name field; its membership links are left out of the general links section.

## In the app and for agents

The contact profile shows a collapsed **Private to you** card. Opened, it keeps
to one screen: importance and cadence are two chips (cadence choices unfold on
tap), and the add-link form appears only after **+ Add link**. Above the card,
**Asks** shows what the person shared with the viewer (`GET /api/stories/feed?author=<userId>`,
or `oc_list_story_feed` with `authorId` for agents); that is their public-to-you
side and is not part of the private graph. A linked thing
opens its own page, where more links and notes can be added. **Catch up**, on
the People screen, lists who is due. Agent tools: `oc_get_person` (name, shared asks and the private card in one read), `oc_get_person_private`, `oc_get_unlinked_person_private`, `oc_list_private_links`, `oc_search_private`, `oc_get_neighbourhood`, `oc_save_private_thing`,
`oc_set_person_private`, `oc_add_private_note`, `oc_delete_private_note`,
`oc_add_private_link`, `oc_update_private_link`, `oc_delete_private_link`, `oc_update_private_thing`, `oc_delete_private_thing`, `oc_list_private_things`,
`oc_get_private_thing`, `oc_list_catch_up`, and the
[contact-source and People-state tools](#contact-sources-and-people-state). Read results include provenance,
`relationType`, `since`, `until`, `context` and `updatedBy` on relations and
`description` on things. `oc_save_private_thing` takes `description` and the
`topic` kind; `oc_add_private_link` takes `relationType`, `since`, `until` and
`context`; `oc_update_private_link` edits any of `relation`, `assertion`,
`relationType`, `since`, `until` and `context`; `oc_update_private_thing`
renames, describes or re-kinds a saved thing. The same tools exist on the
shared Ideaflow connector (which lists OpenChat's catalog live) and on the
OpenChat MCP server for agent keys. Unlinked's read-only view is described
under [What it holds](#what-it-holds). Unlinked people, including imported LinkedIn contacts, are reached with
`toKind`/`subjectKind` `unlinked` (see [People from Unlinked](#people-from-unlinked)).

## Tests

`contacts.adapters.test.ts` exercises the MCP SDK, connector dispatch and
authenticated route attribution with a mocked graph service; it does not
establish database persistence or native-device behavior.

`privateGraph.test.ts` (rules), `privateGraph.route.test.ts` and
`privateGraph.scope.test.ts` (routes, provenance), `privateGraph.mobile.test.ts` (card),
`overlayVendor.test.ts` (vendored files match the pinned Noos commit),
and `privateGraph.integration.test.ts`, `privateGraph.people.integration.test.ts`,
`privateGraph.provenance.integration.test.ts` (provenance, legacy records,
relation edits, search, neighbourhood), `privateNoteReview.integration.test.ts` and
`privateAsks.integration.test.ts` (asks, owner isolation, the migration),
which run against a real Neo4j when
`NEO4J_TEST_URI`, `NEO4J_TEST_USER` and `NEO4J_TEST_PASSWORD` are set.
