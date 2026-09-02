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

## Decisions resolved

### From 2026-05-30 voice convo

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

### From 2026-05-31 voice convo (refining codex's pushback)

| # | Decision | Resolution |
|---|---|---|
| D9 | Tag capture syntax — start-of-message only (codex), or anywhere in message? | **Anywhere.** A message can contain `... and #idea this is the gist ...` and the tagged span gets captured. We accept the slightly-magical parsing in exchange for ergonomic chat. Mitigation: capture creates a `:Thought` that's clearly attributed back to the source message + clearly affords undo. |
| D10 | Status on Thought items — only on status-having kinds (D5 had this), or on everything? | **Every item can carry a status.** Status enum: `null` (or `'not-an-issue'` — they're equivalent), `done`, `not-done`, `in-progress`, `acknowledged`. A `kind: 'fact'` item normally has `status: null` but the user can promote it (mark a fact as "acknowledged" e.g.) without changing kind. Simpler than D5's "status only on kind=decision/commitment/reminder." |
| D11 | "Note captured in a group, but kept private to me" — codex flagged this as a real distinction your visibility-set can't express. | **Defer to a future ticket** (OpenChat-3kr.6 — see Open Questions). v1 ships with: if you `#idea` inside a group, item is visible-to-the-group by default. Going private-from-a-group is a v2 affordance. Long-form: revisit when we need it, possibly bringing in codex's `homeScope` + `visibility` two-axis model if the simpler single-axis can't grow into it cleanly. |

### From codex 2026-05-31 review (incorporated)

- **`:Thought` is too narrow a name.** Codex prefers `:StreamItem` / `:MemoryItem` with `kind` + tags as annotations. Adopting — schema uses `:StreamItem` going forward; "Thoughts" stays as the user-facing feature name.
- **Provenance fields are first-class:** `sourceMessageId`, `sourceConversationId`, `sourceChannel`, `captureMethod` — added to schema below.
- **Author identity split:** `createdByUserId` (who actually typed/extracted) and `ownedByUserId` (whose stream it belongs to). Identical for manual capture; diverge when an agent captures for a human.
- **Tag normalization deferred** — store strings as-typed for v1; build a canonical lowercased index when needed.
- **Edit / delete policy v1:** edit allowed on manual items by `createdByUserId`. Delete = soft (`hidden=true`). Synced sources read-only.

---

### From 2026-09-02 (Jacob, via Claude session — resolves all five open questions below)

| # | Decision | Resolution |
|---|---|---|
| D12 (Q1) | Open-threads-with-others visibility | **Opt-in shareable, default private.** Same per-thought "Send to…" affordance; implements naturally via the visibility set. |
| D13 (Q2) | Relationship to Thoughtstreams / NoteStream | **NoteStream is the canonical note store; Thoughtstreams becomes the social-network view of NoteStream.** "Thoughtstream" is the general phenomenon with different filters over it; its data structure will closely mirror NoteStream notes. NoteStream is NOT mirrored onto Neo4j yet, so **OpenChat Thoughts keeps writing its own `:Thought` nodes in Neo4j for now**; when the NoteStream→Neo4j mirror lands, converge the schemas (they're already shaped alike). |
| D14 (Q3) | Agents reading user thoughts | **Yes — agents should read your thoughts.** "It's hugely important that agents do everything." No consent ceremony required for your own agents. |
| D15 (Q4) | Bot citation posture | **Private bots may quote your thoughts verbatim** — you often want the original text for sharing, so reference-only is too restrictive (revised 2026-09-02, Jacob). Remaining guardrail: a bot shouldn't volunteer your private thoughts *unprompted into a shared/group conversation* — quoting there is fine when you ask it to share. |
| D16 (Q5) | Leave-a-group semantics | **Shared thoughts stay visible to remaining members after the author leaves** — same as chat messages. |

Note: pinning (shipped 2026-09-02, PR #22) implements the Plan B "visible to a conversation" case — `PINNED_IN` relationship + chat-scoped view.

## Open questions (RESOLVED 2026-09-02 — see D12–D16 above; kept for context)

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

## Data model (Neo4j, target shape, updated 2026-05-31)

```cypher
(:StreamItem {
  id: string,
  // Identity / ownership
  createdByUserId: string,             // who actually typed/extracted
  ownedByUserId: string,               // whose stream this lives in (= creator for manual; diverges when agent captures for human)
  // Type + status
  kind: 'fact' | 'decision' | 'commitment' | 'reminder' | 'observation' | 'note',
  status: 'done' | 'not-done' | 'in-progress' | 'acknowledged' | null,
  content: string,
  tags: string[],                      // ['idea', 'todo', 'book', ...] — as-typed in v1, normalized later
  // Provenance — first-class (codex pushback)
  source: 'manual' | 'tagged-from-chat' | 'extraction' | 'bd-sync' | 'chat-snippet',
  sourceMessageId: string | null,      // the chat message that produced this, if any
  sourceConversationId: string | null,
  sourceChannel: 'openchat' | 'imessage-bridge' | 'cli' | null,
  captureMethod: 'composer' | 'inline-tag' | 'agent-suggestion' | 'bulk-sync' | null,
  // Legacy / cross-refs
  refKind: 'memory' | 'issue' | null,
  refId: string | null,
  refExtra: string (JSON),             // {bd status, conv-id, etc.}
  // Lifecycle
  createdAtSource: datetime,
  capturedAt: datetime,                // feed sort key (when entered owner's stream)
  updatedAt: datetime,
  hidden: boolean,                     // soft-delete
  previousId: string | null,           // for decision supersession chains
  closedAt: datetime | null,           // for status transitions to terminal state
})

(:User)-[:CREATED]->(:StreamItem)         // immutable creator
(:User)-[:OWNS_STREAM_ITEM]->(:StreamItem) // mutable owner (rare moves)
(:StreamItem)-[:VISIBLE_TO]->(:User)
(:StreamItem)-[:VISIBLE_TO]->(:Conversation)
(:StreamItem)-[:FROM_MESSAGE]->(:Message)  // when sourceMessageId is set
```

**Naming note:** the storage node is `:StreamItem` (codex's recommendation — more accurate for the heterogeneous payload). The user-facing feature stays "Thoughts" (the tab, the verb "capture a thought", etc.).

**Status semantics:**
- `null` means "no lifecycle" — applies to most facts/observations
- `done` / `not-done` are the basic todo binary; `not-done` is the active state
- `in-progress` for things you've started but haven't finished
- `acknowledged` for things you've seen / decided to engage with but no further state yet
- Any kind can carry any status (per D10) — kind and status are orthogonal axes

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
