# Agent Overlay — Milestone 2 (FROZEN SPEC)

> Historical milestone spec. The current product and privacy contract is
> [`agent-social-layer.md`](./agent-social-layer.md); it supersedes the deferred
> Stories scope, two-client parity, and modal-only desktop treatment below.

**Status:** frozen implementation spec · **Date:** 2026-09-02 · **Epic:** OpenChat-a0e.5
**Builds on:** `docs/design/agent-network-quiet-match.md` (M1, deployed 2026-09-02). No server changes required — M1's REST + `match:updated` socket event are the entire backend surface.

## Product frame

M1 put the quiet-match loop inside the My Agent DM. M2 makes the agent reachable
from anywhere in the app: a lightweight overlay showing your asks/offers and
pending matches, with inline approve/decline and a guarded publish flow.
Ordinary chat stays the baseline; the overlay is opt-in per open, never
interrupts, and human-visible Stories remain deferred.

## Surface & navigation (follow existing repo patterns — no new UI paradigms)

- **Mobile (`apps/mobile`)**: a new `AgentOverlay` screen registered in the
  Chats stack with `presentation: 'modal'` (the GroupInvite/ForwardPicker/
  NewConversation pattern). Route + params in `src/navigation/types.ts`.
- **Entry points (mobile)**: an agent icon button in the ConversationsScreen
  header AND the ChatScreen header. Shows a **badge dot when ≥1 match has
  per-viewer status `pending`**. Desktop widths reach the same screen via
  MasterDetailLayout's existing navigation affordances (modal presents centered
  — acceptable; no bespoke side panel in M2).
- **Legacy web (`apps/web`)**: an agent icon button in the ChatSidebar header
  (next to "New") opening an overlay panel/modal component (`AgentOverlayPanel`)
  — same content, Tailwind styling, same badge-dot rule.

## Overlay content (both clients, identical structure)

1. **Pending matches** (top, most urgent): each pending match rendered with the
   SAME data + privacy rules as M1's `match_proposal` card — anonymous other-side
   kind + terms, own intent summary, Approve/Decline via
   `POST /api/matches/:id/respond`. Reuse/extract the existing AgentNetworkCard
   logic where practical (shared respond handling; visual container may differ).
   `awaiting_other` matches show read-only "waiting" state; `connected` matches
   show an "Open conversation" action; `closed` are omitted from the overlay
   (they remain visible in the My Agent DM history).
2. **Your asks & offers**: list from `GET /api/intents` (kind, terms, status),
   with a Withdraw action (`PATCH {status:'withdrawn'}`, confirm first) on
   active ones.
3. **New ask/offer composer**: kind toggle (Ask/Offer), terms input (1–500),
   optional private details (≤2000, labeled "Only you and your agent see this").
   Submitting shows a **confirm step that echoes the exact anonymous terms**:
   "This exact text becomes anonymously discoverable to other people's agents."
   [Publish] [Edit]. Publishing calls `POST /api/intents`. This mirrors the
   Assistant's echo-terms-and-confirm rule — publishing is the discovery opt-in;
   never publish on first tap.
4. **Footer link**: "Chat with your agent" → the My Agent DM. Mobile: call
   `POST /api/assistant/ensure` (add a small client method; web already has
   `ensureAssistant()`) then navigate to that conversation.

## Live updates (finally consume `match:updated`)

- Server already emits `match:updated` `{match: <per-viewer projection>}` to
  `user:<id>` rooms on proposal and resolution (M1).
- Both clients: subscribe in their ChatContext (the single socket-event home —
  screens must not subscribe directly, per repo convention), keep a `matches`
  map in context state, and refresh badge/overlay/card states from it.
- On overlay open, always refetch `GET /api/matches` (socket events are
  best-effort, not a source of truth).
- The M1 AgentNetworkCard `match_proposal` cards should also react to
  `match:updated` for their matchId (a card approved from the overlay or
  another device updates in place instead of showing a stale Approve button).

## Privacy invariants (unchanged from M1 — restate for implementers)

- Never display or request the other side's identity, avatar, response state,
  or `details` for any non-connected match. The per-viewer REST projection is
  the ONLY match data source; do not derive anything beyond it.
- No auto-opener on connect; the overlay's "Open conversation" just navigates.

## Acceptance (manual + typecheck gates; no new server tests needed)

1. Badge dot appears on entry points when a pending match exists; clears when
   resolved (live via socket, and on refetch).
2. Publish flow: cannot publish without the explicit confirm step; published
   intent appears in the list as `active`.
3. Approve from overlay → `awaiting_other` state in place; second side's
   approval (other account) flips it to `connected` live, with working "Open
   conversation" into the (deduped) DM containing the context card.
4. Decline from overlay → match disappears from overlay; no identity ever shown.
5. Withdraw asks confirmation, then intent shows `withdrawn`.
6. M1 in-DM proposal cards update in place when the same match is resolved
   elsewhere.
7. Web/mobile parity: all of the above on both clients; `npm run lint`,
   `typecheck`, `build` green at root; `apps/mobile` `tsc --noEmit` clean.

## Non-goals (M2)

- No server/API changes, no new message types, no Stories, no match history
  view beyond the My Agent DM, no push notifications, no side-panel redesign
  for desktop, no editing intents in place (withdraw + republish remains the
  model).
