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

**One owner of the rules.** `services/overlay/contract.ts` and
`services/overlay/store.ts` are byte-for-byte copies of Noos `src/overlay/`,
which alone implements the overlay's semantics: names never merging, retries,
note dedupe, provenance, relation types, relation edits, search and
neighbourhood. `services/overlay/NOOS_SOURCE.json` pins the Noos commit and each
file's SHA-256, and `apps/server/test/overlayVendor.test.ts` fails CI if a copy
differs. Change the files in Noos first, then run
`node scripts/vendor-noos-overlay.mjs <path-to-clean-noos-checkout>`.
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
| `GET /things?q=&kind=`, `GET /things/:thingId` | Saved things (with `description`), and one with its notes and links |
| `PATCH /things/:thingId` | `{ name?, description?, kind? }`: rename, describe (`null` or `''` clears) or change the kind of a saved thing (an idea that became a project). Someone on Unlinked keeps their kind (409); an OpenChat person's card answers 404 |
| `DELETE /things/:thingId` | Delete (undo) a saved thing: the entity, its notes, its links in both directions and its refs, plus OpenChat's note reviews and asks about it, in one transaction. Answers `{deleted: true, id, notesRemoved, linksRemoved}`; a missing, already-deleted or foreign id, or an OpenChat person's card, answers 404 |
| `POST /things`, `POST /things/resolve` | `{kind, name, description?}` / `{kind, name, description?, createNew?, clientRequestId?}`: find or save by name under the no-merge rules below. A description is stored on a new thing and fills an existing thing's blank one; it never replaces one |
| `GET /due` | People whose catch-up date has passed |
| `GET /links?q=` | Every link the owner recorded, newest first, filtered by a name or relation |
| `GET /unlinked-people/:profileId` | Card, notes and links for an Unlinked profile (never creates, never calls Unlinked) |
| `POST /unlinked-people/:profileId/notes`, `POST /unlinked-people/:profileId/links` | Note or link about an Unlinked profile |

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

Account export includes the owner's private graph under `privateGraph`
(entities, notes and links). Account deletion removes everything the person
kept, under either identity that can name them, and removes other owners'
entities that knew them only as an OpenChat account.

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
`oc_get_private_thing`, `oc_list_catch_up`. Read results include provenance,
`relationType`, `since`, `until`, `context` and `updatedBy` on relations and
`description` on things. `oc_save_private_thing` takes `description` and the
`topic` kind; `oc_add_private_link` takes `relationType`, `since`, `until` and
`context`; `oc_update_private_link` edits any of `relation`, `assertion`,
`relationType`, `since`, `until` and `context`; `oc_update_private_thing`
renames, describes or re-kinds a saved thing. The same tools exist on the
shared Ideaflow connector (which lists OpenChat's catalog live) and on the
OpenChat MCP server for agent keys. Unlinked does not show this knowledge yet; tool descriptions say
so. Unlinked people, including imported LinkedIn contacts, are reached with
`toKind`/`subjectKind` `unlinked` (see [People from Unlinked](#people-from-unlinked)).

## Tests

`privateGraph.test.ts` (rules), `privateGraph.route.test.ts` and
`privateGraph.scope.test.ts` (routes, provenance), `privateGraph.mobile.test.ts` (card),
`overlayVendor.test.ts` (vendored files match the pinned Noos commit),
and `privateGraph.integration.test.ts`, `privateGraph.people.integration.test.ts`,
`privateGraph.provenance.integration.test.ts` (provenance, legacy records,
relation edits, search, neighbourhood) and `privateNoteReview.integration.test.ts`,
which run against a real Neo4j when
`NEO4J_TEST_URI`, `NEO4J_TEST_USER` and `NEO4J_TEST_PASSWORD` are set.
