# Private graph

A person's own notes and links about the people they know. Everything here
belongs to one owner and is shown only to that owner: the person a note or
link is about never sees it, and nothing in it is read by search, matching,
Stories or anyone else's profile.

## What it holds

Storage is the people overlay, a layout owned by Noos and kept in the graph
database OpenChat shares with it. OpenChat is one view of it; another Ideaflow
app can show the same owner the same notes.

| Stored as | Meaning |
|---|---|
| `OverlayEntity` | A person, company, idea or project the owner keeps something about. Importance and catch-up cadence sit on it. One made by name is unique per owner, kind and name. |
| `OverlayRef` | How an app points at an entity. A person on OpenChat is the entity named by `openchat:user:<id>`; an entity can carry refs from several apps. |
| `OverlayNote` | A note about an entity. |
| `OVERLAY_LINK` | A real relationship between two of the owner's entities, with the relation in the owner's own words ("knows", "works at", "interested in"). |

Every node and link carries the owner's key and every query is anchored on it.
The key is derived from the owner's Ideaflow sign-in when they have one, so the
overlay is theirs across Ideaflow apps; an account without one is keyed by its
OpenChat id, and what it wrote moves to the Ideaflow key when the sign-in is
linked. `services/overlay/` is the layout's code, kept in step with the Noos
repository; `services/privateGraph.ts` is OpenChat's side: who may be written
about (no bots, no blocks, not yourself) and the response shapes below.

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
| `POST /people/:userId/links`, `POST /things/:thingId/links` | `{ relation, to }` where `to` is `{kind:'user', id}` or `{kind:'person'\|'company'\|'idea'\|'project', id \| name}`; a name creates or reuses the saved thing |
| `DELETE /links/:linkId` | Remove a link |
| `GET /things?q=&kind=`, `GET /things/:thingId` | Saved things, and one with its notes and links |
| `DELETE /things/:thingId` | Delete (undo) a saved thing: the entity, its notes, its links in both directions and its refs, plus OpenChat's note reviews and asks about it, in one transaction. Answers `{deleted: true, id, notesRemoved, linksRemoved}`; a missing, already-deleted or foreign id, or an OpenChat person's card, answers 404 |
| `POST /things/resolve` | `{kind, name, createNew?, clientRequestId?}`: find or save by name under the no-merge rules below |
| `GET /due` | People whose catch-up date has passed |
| `GET /links?q=` | Every link the owner recorded, newest first, filtered by a name or relation |
| `GET /unlinked-people/:profileId` | Card, notes and links for an Unlinked profile (never creates, never calls Unlinked) |
| `POST /unlinked-people/:profileId/notes`, `POST /unlinked-people/:profileId/links` | Note or link about an Unlinked profile |

## People from Unlinked

An Unlinked profile is the overlay entity named by `unlinked:person:<profileId>`,
the ref Unlinked itself uses, so Unlinked's own view of the same owner reads the
same entity. The first write about a profile confirms it with the owner's own
read-only Unlinked grant (the identity-scoped provisioning OpenChat already uses
for Unlinked search): only an id Unlinked's published People index answers for
becomes a person here, under the canonical id when a profile was merged. Later
writes and every read use the stored ref and do not call Unlinked. Profiles that
exist only in the owner's private Unlinked import are not published, so they
cannot be confirmed and are refused; record them as a saved person by name.
A link `to` may be `{kind:'unlinked', id}`; link ends that are Unlinked profiles
carry `unlinkedProfileId` next to their saved-thing `id`.

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

The overlay stores `createdAt` on notes and links but no separate provenance
(which agent or connector wrote it). Adding that is a change to the Noos-owned
layout and is not done here.

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
the People screen, lists who is due. Agent tools: `oc_get_person` (name, shared asks and the private card in one read), `oc_get_person_private`, `oc_get_unlinked_person_private`, `oc_list_private_links`, `oc_save_private_thing`,
`oc_set_person_private`, `oc_add_private_note`, `oc_delete_private_note`,
`oc_add_private_link`, `oc_delete_private_link`, `oc_delete_private_thing`, `oc_list_private_things`,
`oc_get_private_thing`, `oc_list_catch_up`.

## Tests

`privateGraph.test.ts` (rules), `privateGraph.route.test.ts` and
`privateGraph.scope.test.ts` (routes), `privateGraph.mobile.test.ts` (card),
and `privateGraph.integration.test.ts` and `privateGraph.people.integration.test.ts`
(including saved-thing deletion), which run against a real Neo4j when
`NEO4J_TEST_URI`, `NEO4J_TEST_USER` and `NEO4J_TEST_PASSWORD` are set.
