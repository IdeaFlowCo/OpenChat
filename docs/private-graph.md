# Private graph

A person's own notes and links about the people they know. Everything here
belongs to one owner and is shown only to that owner: the person a note or
link is about never sees it, and nothing in it is read by search, matching,
Stories or anyone else's profile.

## What it holds

| Node | Meaning |
|---|---|
| `OpenChatPersonCard` | The owner's settings for one person: importance, catch-up cadence, last catch-up. One per owner and person. |
| `OpenChatPrivateNote` | A note about a person or a saved thing. |
| `OpenChatThing` | A saved company, idea, project, or person who is not on OpenChat. Unique per owner, kind and name. |
| `OpenChatPrivateLink` | A relation in the owner's own words ("knows", "works at", "interested in") from a person or thing to another. Carries real `LINK_FROM` / `LINK_TO` relationships to its endpoints, so the overlay is traversable in the shared graph. |

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
| `GET /due` | People whose catch-up date has passed |

Account export includes the owner's private graph under `privateGraph`.
Account deletion removes everything the person wrote and every card, note and
link other people keep about them.

## In the app and for agents

The contact profile shows a collapsed **Private to you** card. A linked thing
opens its own page, where more links and notes can be added. **Catch up**, on
the People screen, lists who is due. Agent tools: `oc_get_person_private`,
`oc_set_person_private`, `oc_add_private_note`, `oc_delete_private_note`,
`oc_add_private_link`, `oc_delete_private_link`, `oc_list_private_things`,
`oc_get_private_thing`, `oc_list_catch_up`.

## Tests

`privateGraph.test.ts` (rules), `privateGraph.route.test.ts` and
`privateGraph.scope.test.ts` (routes), `privateGraph.mobile.test.ts` (card),
and `privateGraph.integration.test.ts`, which runs against a real Neo4j when
`NEO4J_TEST_URI`, `NEO4J_TEST_USER` and `NEO4J_TEST_PASSWORD` are set.
