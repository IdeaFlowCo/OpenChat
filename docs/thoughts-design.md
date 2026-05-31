# Thoughts — design doc

Source-of-truth design for OpenChat's "Thoughts" feature. Tracks both the original plan and the codex-alternative redesign that landed on top of it, the resolved decisions from the 2026-05-30 voice conversation (raw transcript at `~/memory/research/2026-05-30-openchat-thoughts-design-conversation.md`), and the remaining open questions.

This doc is the authoritative reference for the `OpenChat-3kr` epic + sub-tickets. Keep in sync; treat divergence between this doc and the tickets as a bug.

---

## What we're building (one-line)

A unified chronological feed of the user's notes, LLM-extracted thoughts from chats, persistent memories, and (optionally) beads issues — sitting as a peer surface alongside Chats inside OpenChat. Shareable per-thought via a flexible visibility set; not a separate "team Notion" but a thinking layer that the social graph feeds.

---

## Plan A — original (Jacob's initial framing)

- Two scopes: `personal` and `conversation`
- A Thought owned by a `User` is private to that user
- A Thought owned by a `Conversation` is visible to all current participants
- Sources of personal stream are toggleable per-user: notes, memories, beads issues, chat snippets
- v1 = manual capture + a 5-min cron sync from bd on Mac mini → server `:Thought` upsert
- Real-time later: bd hooks for <1s latency, then socket.io fan-out
- Settings UI: list of source toggles with defaults `note:on, memory:on, issue:off, snippet:on`

Strengths: simple to model, matches how Jacob currently uses bd + memories. Privacy boundary is clear (one owner, one scope).

Weaknesses (from codex critique):
1. All-passive ingestion. Nothing here is impossible in a notes app.
2. Hard binary scope makes peer-to-peer sharing (Srini + Jacob share a thought, not the whole group) a schema change later.
3. "Conversation-scoped thought" is a derived view of a more general visibility model; modeling it as a scope locks the data shape too early.

---

## Plan B — codex alternative (more ambition + flexible visibility)

### Visibility set instead of scope

```
Thought {
  id, kind, content, source, refKind, refId,
  createdAtSource,        // when it was born in the source (bd, chat, etc.)
  capturedAt,             // when it entered Jacob's stream — feed sort key
  updatedAt, hidden, previousId,
  authorUserId,           // immutable — who wrote/extracted it
  visibility: Set<UserId | ConversationId>,  // mutable — who else can see
}
```

| Visibility set | Meaning |
|---|---|
| `{}` | Private to author |
| `{convId}` | Shared with that conversation (all current participants) |
| `{otherUserId}` | Shared peer-to-peer with one other person |
| `{convId, otherUserId}` | Multi-share |

Same data, multiple views. Group's "Notes" view = "thoughts visible to this conversation by any author." Retract a thought from a group by removing that conv-id from its visibility set (no delete needed). Peer-to-peer thought-sharing without new schema.

### Kind taxonomy (LLM-extractor uses this)

Every Thought has a `kind`. Some kinds have status semantics; others are pure observations.

| Kind | Status-having? | Example |
|---|---|---|
| `fact` | no | "Srini prefers Sichuan over Cantonese" |
| `observation` | no | "Bay Area food scene leans more izakaya than steakhouse" |
| `decision` | yes (active / superseded) | "Use Postgres" (later superseded by "switch to SQLite") |
| `commitment` | yes (open / done) | "I'll send Eric the spec by Friday" |
| `reminder` | yes (open / done / expired) | "Ask Srini about the food-tour idea Tuesday morning" |

Status-having kinds use `previousId` for superseded chains (decisions) and a separate `closedAt` field for done/expired (commitments + reminders).

### Differentiating moves (the actually-novel features)

1. **LLM extraction from chats.** On opt-in conversations, an extractor runs per-message and surfaces "💭 add to thoughts?" with structured kind + visibility suggestion. Default is opt-in per-conv; the user always confirms before a Thought is created from a message.
2. **Time-shifted contextual surfacing.** Opening a DM with Eric shows "💭 1 from Monday" if there's a recent commitment / reminder tagged with him or the conversation. Chat-as-the-surfacing-mechanism, not the Thoughts tab.
3. **Compose-from-thoughts.** Multi-select N thoughts → "draft a message from these to [picker]." LLM synthesizes one coherent message. Bridges solo thinking to shared writing.
4. **Peer-to-peer thought sharing.** Jacob "shares to Srini" a thought; it shows in Srini's Thoughts tab tagged "from Jacob." Not a chat message — a shared note item with reactions/annotations.

### Cuts vs Plan A

- **bd integration moved out of default v1.** Optional toggle, off by default for non-Jacob users; on by default for Jacob himself.
- **Issues kept toggleable not killed** (per Jacob's 2026-05-30 decision — see "Decisions" below). One linear stream, filter chip for the work view.
- **Synced sources are read-only in-app.** "Edit memory" deep-links to `bd remember --key X`. Avoids sync conflicts.

---

## Decisions resolved (2026-05-30 voice convo)

| # | Decision | Resolution |
|---|---|---|
| D1 | One stream or multiple tabs for status-having items? | **One stream + filter chip.** Open commitments / reminders render inline with a status pill. No separate Work tab. |
| D2 | Kill bd issues entirely or keep as a toggle? | **Keep as toggleable source.** Default off for new users, default on for Jacob. |
| D3 | Visibility model — Plan A scope vs Plan B set? | **Plan B (visibility set).** Author immutable, visibility mutable. Empty = private. |
| D4 | v1 sources? | **Manual notes + LLM extraction from chats.** bd sync deferred to v1.1, memories surfaced via existing `bd remember` only when toggle on. |
| D5 | Kind taxonomy on each thought? | **fact / decision / commitment / reminder / observation.** Status semantics only on decision/commitment/reminder. |
| D6 | Where do open-to-self threads ("I owe Eric a reply") and unresolved-questions-from-a-conversation live? | **Flow into the personal stream by default**, with the conv-id in their refExtra so chat surfacing can find them. |
| D7 | Real-time strategy? | **Three tiers, ship sequentially.** v1: 5-min cron sync. v1.5: bd hooks for <1s. v2: socket.io fan-out. |
| D8 | Default state of source toggles for a new user? | **note:on, memory:on, issue:off, snippet:on** for new users. Jacob's account override: issue:on. |

---

## Open questions (NOT resolved)

### Q1 — Are open-threads-with-others optionally visible to the other person?

> "I owe Eric a response" lives in Jacob's personal stream. Should Jacob be able to opt-in to share it with Eric so Eric can see "Jacob has an open thread with you about X"?

Two possible answers:

- **Always private.** Simpler. Matches the "personal stream is yours" intuition. Easy to reason about: no one can see what you've noted about them.
- **Optionally shareable.** More powerful. Lets pairs of people sync up on what's pending between them. Implements naturally via the visibility set (add the other user's id). Risk: social friction if the language is too pointed ("I'm waiting on Eric") and the other person sees it.

Leaning slightly toward **opt-in shareable**, default private — same per-thought "Send to…" action that exists for chat-sharing. But this needs Jacob's call before we build the share-affordance.

### Q2 — How does Thoughts relate to the existing Thoughtstreams app (`ts.globalbr.ai`)?

The codename overlap is real — Thoughtstreams is the standalone IdeaFlow notes app. Three possible relationships:

1. **Completely separate products.** Thoughtstreams = solo notes, no chat. OpenChat Thoughts = chat-contextual feed. Different audiences.
2. **Same data store, two views.** Both apps read/write the same `:Thought` node in Neo4j; Thoughtstreams stays a "pure notes" UI, OpenChat adds the chat-contextual surfacing.
3. **Thoughts is OpenChat-only.** Thoughtstreams stays untouched; we treat the name overlap as a non-issue.

(2) is the most elegant. Means a Thoughtstream node a user wrote in `ts.globalbr.ai` shows up in their OpenChat Thoughts tab automatically. Cost: schema alignment, a unified back-end. (3) is the cheapest. (1) is incoherent. Jacob hasn't decided.

### Q3 — Should agents (picortex et al) be able to read user thoughts when summoned?

The "agent sees your thoughts" model — needed for time-shifted surfacing to be agent-driven — implies a new permission scope. Plan B sketched: `scope: { personal: false, conversations: [...] }` with explicit consent on first invocation. Not built; needs more thought before we ship. Privacy implication: prompt-injection attacks on agents could leak thoughts; agents must cite "I have prior context" rather than verbatim-quote.

### Q4 — Citation / leak posture for bot replies

Related to Q3. If a bot uses a memory or thought, the reply should reference it ("I recall you mentioned this earlier") rather than quote verbatim. This is a prompt-design constraint baked into the agent contract from day one. Not built; needs to be a hard rule in picortex's reply pipeline.

### Q5 — "Leave a group" semantics for shared thoughts

If Jacob authored a thought visible to a group and then leaves the group: do his thoughts stay visible to remaining members? My instinct yes (same as chat messages — what you shared stays shared). Jacob hasn't confirmed.

---

## Data model (Neo4j, target shape)

```cypher
(:Thought {
  id: string,
  authorUserId: string,                // immutable
  kind: 'fact' | 'decision' | 'commitment' | 'reminder' | 'observation',
  content: string,
  source: 'manual' | 'extraction' | 'bd-sync' | 'chat-snippet',
  refKind: 'message' | 'memory' | 'issue' | null,
  refId: string | null,
  refExtra: string (JSON),             // {bd status, conv-id, etc.}
  createdAtSource: datetime,
  capturedAt: datetime,                // feed sort key (when entered stream)
  updatedAt: datetime,
  hidden: boolean,
  previousId: string | null,           // for decision supersession chains
  closedAt: datetime | null,           // for commitment/reminder done state
})

(:User)-[:AUTHORED]->(:Thought)
(:Thought)-[:VISIBLE_TO]->(:User)
(:Thought)-[:VISIBLE_TO]->(:Conversation)
```

Idempotent upsert for synced sources by `(authorUserId, refKind, refId)`. Manual notes get a fresh nanoid.

Indexes:
- `Thought.id` unique
- `(authorUserId, capturedAt)` composite for the per-user feed
- Full-text on `Thought.content` from day one

User prefs live on `:User`:
```
u.thoughtSources = { note: bool, memory: bool, issue: bool, snippet: bool, extraction: bool }
```

---

## API (target)

```
POST   /api/thoughts                    manual capture
GET    /api/thoughts?include=note,memory,extraction
GET    /api/thoughts?kind=commitment&status=open    filtered views
PATCH  /api/thoughts/:id                edit (manual only; synced read-only)
DELETE /api/thoughts/:id                soft-delete (hidden=true)
POST   /api/thoughts/:id/share          mutate visibility set
POST   /api/thoughts/:id/close          mark commitment/reminder done
GET    /api/thoughts/sources            read u.thoughtSources
PATCH  /api/thoughts/sources            flip a source on/off
POST   /api/thoughts/sync               bulk upsert from sync agent
```

Socket events (v2):
```
thought:added       { thought }
thought:updated     { thought }
thought:removed     { id }
```

---

## Build order

1. **Server**: `:Thought` schema + CRUD + sources endpoint + sync endpoint
2. **Mobile**: ThoughtsScreen wired to live API (replace in-memory demo on `next` branch)
3. **Web**: `/thoughts` route on `next` branch
4. **LLM extraction**: opt-in per-conv toggle, batch-extract on new messages, surface "💭 add?" suggestion
5. **Time-shifted surfacing**: chat header shows recent-context Thoughts
6. **Compose-from-thoughts**: multi-select → LLM-draft message
7. **bd sync agent**: launchd plist on Mac mini (`bd list --json` + `bd memories` → POST /api/thoughts/sync). Optional source.
8. **Peer-to-peer share UI**: "Send to user/conv…" action on each Thought
9. **Real-time fan-out**: bd hooks → /api/thoughts/sync immediate; socket.io thought:* events

Estimated effort: build order 1-3 ≈ one focused session; 4-6 ≈ one session each; 7-9 ≈ one session combined.

---

## Out of scope (deliberately)

- **Rich-text / markdown formatting.** Plain text only at v1. Less than a Notion clone is the goal.
- **Attachments / images.** Goes into the Files feature (separate ticket, not filed yet).
- **Multi-user collaborative editing.** Thoughts are author-owned. Annotations / comments on a shared thought are a v2 conversation.
- **Search inside Thoughts.** Wire the Neo4j full-text index at v1 but no UI until row ~50.

---

## Tickets

Live in beads under epic `OpenChat-3kr` ("OpenChat next: thought-stream tab + agentic + NVC"). Sub-tickets:

- `OpenChat-3kr.1` — Thoughts tab UI (mobile scaffold landed on `next`; web TBD; server CRUD TBD)
- `OpenChat-3kr.2` — NVC composer mode (separate feature in same epic)
- `OpenChat-3kr.3` — Agentic features (summon agent, watchers, automation rules)
- `OpenChat-3kr.4` — bd + memories surface in Thoughts tab (sync agent + server route)

Decisions D1–D8 above should be replicated into each ticket's design field as it gets claimed.
