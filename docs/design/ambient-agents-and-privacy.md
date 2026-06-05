# Ambient Agents in Every Chat + Bot Data-Access / Privacy Model

**Epic:** openchat-j0o · **Status:** design · **Date:** 2026-06-04

## Vision (Jacob)
An AI agent implicitly present in every chat — yours *and* other people's — with bots
present in group chats; the ability to message someone's bot explicitly; and your
assistant able to make another person's bot kick something off. Open question:
per-user agents ("Jacob's agent" + the other person's agent) vs **one** general,
useful agent with skills (e.g. NVC mediation). The crux is **data access / privacy**:
adding your bot to a group must never leak your personal data.

## The invariant (the one rule everything hangs on)
**An agent acting in a context can only read what that context is allowed to read.**
The agent is never a privileged backdoor around access control — it inherits the
permission set of *where it is standing*.
- In your private Assistant DM → it sees *your* private data (today's behavior).
- In a group chat → only that group's shared data + participants' *public* data.
  **Never your private data**, even though it's "your" agent.
- To use something private in a shared context, it must **ask you** (approval flow);
  approval is scoped to that one act, not added to the group's permanent visibility.

## Agent shape: ONE runtime, per-context permission scoping (not N bots)
- **One Assistant runtime** with pluggable **skills** (NVC mediation, summarize,
  catch-me-up, schedule…).
- Your **private assistant** = that runtime scoped to *you* (your DM, your data, your
  memory) — already shipped (openchat-bfn.3).
- The **group agent** = the same runtime scoped to a *conversation* — a neutral
  facilitator with **no private data**, safe by construction.
- "Jacob's agent vs the other person's agent" is then just *which permission context
  is active*, not separate bot identities. (Distinct public-facing bot *endpoints*
  per user come later — see §Messaging a bot.)

Rationale: distinct bot identities multiply the security surface and duplicate the
runtime. One runtime + context scoping is simpler, safer, and still *feels* like "my
agent" in my DM and "a helper" in a group.

## Access-control model (synthesized from prior art)

### Two orthogonal axes (copy Noos)
- **Read visibility** on each item: `private` | `group` | `public` | `unlisted`
  - `private` — owner + owner's private assistant only (DEFAULT)
  - `group` — members of a specific conversation/group (OpenChat's native tier)
  - `public` — anyone (your public profile/info)
  - `unlisted` — readable with a direct link but not surfaced in search/lists
- **Edit/act permission** (later): `owner` | `members` | etc.

### The group principal = Conversation membership (OpenChat's advantage)
Every other project (Noos, WikiHub, Notestream) lacks a real team object and fakes
groups with per-user grants or email allow-lists. OpenChat already has
`(:User)-[:PARTICIPATES_IN]->(:Conversation)`. So a `group`-scoped item is shared
with the members of a specific conversation — no new membership table needed.
Optional later: per-user `SHARED_WITH` grants (Noos/WikiHub style) for one-off shares.

### ONE enforced filter helper (fix Noos's weakness)
Noos copy-pastes its visibility predicate 6+ times (drift risk) AND stores grant tiers
it never enforces. OpenChat will instead:
- Centralize a single `visibilityFilter(viewerId)` Cypher fragment / helper used by
  **every** read path.
- **Enforce** tiers in the filter (don't just store them).
- **Default-deny**: items with no `visibility` are treated as `private` (Cortex lesson).

Reference predicate (read):
```cypher
// item m is readable by viewer $userId when:
m.visibility = 'public'
OR m.visibility = 'unlisted'                                  // (link-gated; same read filter)
OR EXISTS { MATCH (:User {id:$userId})-[:OWNS|HAS_THOUGHT]->(m) }   // owner
OR (m.visibility = 'group' AND EXISTS {
     MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation)<-[:SCOPED_TO]-(m) })
OR EXISTS { MATCH (m)-[:SHARED_WITH]->(:User {id:$userId}) }  // optional per-user grant
```

### Agent context scoping
The agent calls reads through the **same** `visibilityFilter(contextViewerId)`:
- private Assistant DM → `contextViewerId = the owner` (sees their private items)
- group agent → `contextViewerId` resolves to "what a generic member of this
  conversation may see" = `public ∪ this-conversation's group items` (NOT owner private)
API keys already inherit the user's visibility via `resolveActor` (matches Noos) — so
"agent sees what the user sees" is already consistent and free.

## Approval workflow (ours to invent — no prior-art template)
When the group agent (or another's bot) wants to use/send something `private`:
1. It pauses and DMs the owner: "Share *X* into <group>? [Approve once] [Always for this group] [No]".
2. On one-time approve → it uses *X* for that single act; nothing is re-classified.
3. "Always for this group" → reclassify *X* (or that category) to `group` for that conversation.
This is the graceful middle between Cortex's hard isolation and an unsafe open agent.

## Scoped memory
The agent's memory is partitioned by the same axes: a **private** memory store (yours,
only your private assistant) and **per-group** shared memory (visible to members). Graded
isolation rather than Cortex's all-or-nothing per-tenant boundary.

## Messaging a bot explicitly + agent-to-agent
- Each user can expose a **public-facing bot endpoint** ("message Jacob's assistant")
  that answers only from `public`/approved info + skills — a personal API behind a
  permission wall.
- **Your assistant triggering another's bot** = agent-to-agent: your assistant
  @mentions/DMs their bot; their bot replies under *its owner's* permission scope. The
  `/api/assistant/forward` + `@agent` plumbing already shipped (openchat-ug6) is the seed.

## NVC mediation as a skill (plugin model)
Skills are modular, declared with {name, when-to-use, tool(s), prompt}. NVC mediation:
in a heated thread, `@assistant mediate` reframes the exchange in Nonviolent
Communication (observations · feelings · needs · requests). Runs on **shared** context
only (group agent), so it needs no private data.

## Minimal demo ("poor man's version") — Thoughts visibility
Smallest concrete change that demonstrates the whole model end-to-end, reusing the
existing Thoughts feature (confirmed trivial by research):
1. Add `visibility: 'private'|'group'|'public'` (default `'private'`) to `:Thought`.
   Files: `apps/server/src/routes/thoughts.ts` (VALID_VISIBILITY set; add to POST CREATE
   map, PATCH CASE-WHEN branch, and every `t {…}` RETURN projection) +
   `apps/server/src/services/extractThoughtsFromMessage.ts` (tag-extracted thoughts default private).
2. Add the single `visibilityFilter` helper + a new read path (e.g. a 7th Assistant tool
   `search_visible_thoughts` and/or `GET /api/thoughts/visible`) that returns `public`
   (now) and `group`-scoped (once wired to conversation membership) thoughts — never private.
3. Default `'private'` means all existing thoughts stay owner-only — **safe by default**.

## Prior-art comparison (what we copy / avoid)
| Project | Visibility levels | Group/team | Granularity | Take for OpenChat |
|---|---|---|---|---|
| **Noos** (Neo4j ✓) | public/unlisted/private/shared + editPermission | none (deployment gate; per-record team planned) | per-item, per-query filter | **Closest template.** Copy 2-axis model + per-query filter, but extract ONE helper + enforce tiers. |
| **WikiHub** | private/public-view/public-edit/unlisted-* | none; per-user `@user:role` grants + email PendingInvite | per-item via glob, frontmatter>ACL>default | Copy: container-default + per-item override precedence; email-invite→grant materialization. |
| **Notestream** | derived (isPublished + accessMode + accessEmails[]) | none; email allow-list; per-#hashtag container share | per-item + per-container | Copy: per-container (conversation) default + per-item override; UNLISTED vs LISTED. |
| **Cortex** | n/a (infra isolation) | WorkspaceMember (1 group→1 workspace) | per-tenant container/VM | Wrong shape for chat. Lesson: default-deny + explicit shares only. |

**Cross-cutting:** none have a real team object — OpenChat's `Conversation` membership is
the differentiator and the right group principal.

## Phasing
1. **Thoughts visibility demo** + the `visibilityFilter` helper *(small — proves the model)*
2. **Conversation/group-scoped read layer** — the agent's context-scoped reads *(the real substrate)*
3. **Neutral group agent + skill-plugin model + NVC skill** *(the marquee UX)*
4. **Approval workflow** for private-data use in shared contexts *(safety)*
5. **Public bot endpoint + agent-to-agent** *(network effect)*

## Open questions for Jacob
- **"Collura"** — no repo/file/memory matches it. Best guesses: a typo for **Cortex**, or
  **Collab/Collablists** (your noos `#collablists`/`#agent-collab` nodes). Which did you mean?
- **Distinct bot identities** after all, or is the single-runtime + per-context model right?
- Should the group agent be **opt-in per conversation** (added like a participant) or
  **ambient** (always available via `@assistant`)? (Recommend opt-in via `containsBot`.)
