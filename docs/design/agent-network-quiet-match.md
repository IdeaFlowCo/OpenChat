# Agent Network — Milestone 1: Quiet-Match Loop (FROZEN CONTRACT)

**Status:** frozen implementation contract · **Date:** 2026-09-02 · **Branch:** `feat/agent-network-quiet-match`
**Product owner decisions by:** Fable (herder agent), confirmed direction from Jacob.
**Prior art:** `docs/design/ambient-agents-and-privacy.md` (privacy invariant), `docs/agent-integration-paths.md` (integration layering).

## Product frame (confirmed by Jacob)

- One OpenChat app, layered experiences; ordinary chat remains the baseline.
- Every OpenChat account may participate from the start. **Discovery participation is explicit per Ask/Offer** (publishing an intent *is* the opt-in). No silent activation, no account-level flag needed.
- **Before mutual approval, only anonymous relevant terms are shown.** No names, no user ids, no avatars, no source messages, no mutual-connection identity.
- Milestone 1 = the complete quiet-match loop inside the canonical **My Agent** chat (the existing per-user Assistant DM). The in-chat agent overlay is the immediate *next* milestone (filed, not built here). Human-visible Stories are deferred.
- After mutual approval: **create/reuse a normal DM** between the two humans with a **neutral context card**; never auto-send an opener on anyone's behalf.
- Provider-neutral seams: the hosted Assistant is one client of the same REST surface; external agents (Claude/ChatGPT-compatible MCP clients, scripts) use the same endpoints via `oc_` agent keys. **Inbound OpenChat→agent execution** (hosted Assistant runtime, outbound webhooks) and **external-agent→OpenChat access** (REST/MCP with agent key) are distinct flows. We do NOT pretend consumer ChatGPT/Claude chat sessions are callable endpoints — no reverse-invocation promise.

## Data model (Neo4j, shared instance — labels chosen to avoid Noos collisions)

Follow the repo pattern: inline Cypher, idempotent `ensureAgentIntentIndexes()` in the owning service, wired into `start()` in `apps/server/src/index.ts` (same pattern as `ensureWebhookIndex()`).

```cypher
(:AgentIntent {
  id,               // nanoid
  ownerUserId,
  kind,             // 'ask' | 'offer'
  terms,            // ANONYMOUS public text — the ONLY content ever shown to the other side pre-approval
  details,          // optional private context; visible ONLY to owner + owner's own agent; never to the other side, even post-approval
  status,           // 'active' | 'withdrawn' | 'connected'
  expiresAt,        // optional discovery expiry; null means no automatic expiry
  createdAt, updatedAt
})
(:User)-[:OWNS_INTENT]->(:AgentIntent)

(:AgentMatch {
  id,
  status,           // 'proposed' | 'closed' | 'connected'
  score,            // matcher score at proposal time
  aResponse,        // null | 'approved' | 'declined'   (a = intent with lexicographically smaller id — deterministic)
  bResponse,
  conversationId,   // set when connected (the human DM)
  createdAt, updatedAt
})
(:AgentMatch)-[:MATCHES]->(:AgentIntent)   // exactly two edges
```

Constraints/indexes: unique on `AgentIntent.id`, `AgentMatch.id`; index on `AgentIntent.ownerUserId`, `AgentIntent.status`. Never re-propose a pair: before creating a match, check no existing `AgentMatch` joins the same two intents (any status).

## Matching service ("quiet match")

- Trigger: synchronously-queued scan when an intent is created (fire-and-forget async, like `maybeTriggerAssistant` — never blocks the request).
- Candidates: unexpired `status:'active'` intents of the **complementary kind** (ask↔offer only), different owner, excluding pairs where either user has blocked the other (reuse existing blocking checks), excluding already-matched pairs.
- Scoring pipeline (injectable for tests, mirroring `secretaryMatcher.ts` style):
  1. Token-overlap score (deterministic baseline, always available).
  2. If `OPENAI_API_KEY` set: embedding cosine similarity via the existing `embeddings.ts` helper (embed `terms` only — never `details`).
  3. If `ANTHROPIC_API_KEY` set: LLM verification gate on top candidates — "would this offer plausibly satisfy this ask?" yes/no — to suppress false positives. Skipped silently when unset.
- Threshold via `INTENT_MATCH_THRESHOLD` env (sane default). All scorer stages read ONLY `terms`, never `details`.
- On match: create `AgentMatch{status:'proposed'}` and deliver a **match-proposal card** into each owner's My Agent DM (via `ensureAssistantConversation` + the `persistMessage` pattern in `assistant.ts`, sender `assistant`). Also emit `match:updated` to each `user:<id>` room (clients may ignore in M1).

## Double-opt-in state machine

- `proposed`: both responses null. Each side sees ONLY: match id, own intent (id/kind/terms), other side's **kind + terms**, status *from their own perspective*.
- Per-viewer status projection (server computes; raw `aResponse`/`bResponse` are NEVER returned):
  - `pending` — viewer hasn't responded.
  - `awaiting_other` — viewer approved; **other side's pending/approved state is not revealed**.
  - `closed` — either side declined (never disclosed which side, nor when).
  - `connected` — both approved.
- Responses are idempotent; responding to a non-`proposed` match returns the current per-viewer state with HTTP 200 and `alreadyResolved: true` (no error spam from stale cards).
- On second approval (transition to `connected`):
  1. Create/reuse the human↔human DM using the existing dedup logic in `POST /api/chat/conversations` (extract/reuse the two-user dedup path in `apps/server/src/routes/chat.ts:203-306` as a shared helper — do not duplicate the Cypher). The assistant is NOT a participant; `containsBot` stays false.
  2. Persist one neutral **context card** message in that DM (see card spec). **No auto-opener. No other message.**
  3. Set both intents `status:'connected'` (they leave the discovery pool), match `status:'connected'`, `conversationId` set.
  4. Match-proposal state in each My Agent DM is updated by a follow-up status card from the assistant (we do not mutate old messages).
- On decline: match `closed`. The decliner's My Agent DM gets a quiet confirmation; the other side's card resolves to "no longer available" **only when they next interact with it** (respond → `alreadyResolved`, or refetch) — no proactive "you were declined" ping. Both intents remain `active` and can match elsewhere.

## Card messages (new `messageType: 'card'`)

Message node gains optional props: `cardKind` (string) and `cardPayload` (JSON string). `messageType` values: `'text'` (default) | `'card'`. Persist through the existing message create+broadcast paths so sockets/unread/webhooks all behave normally. Add to `openapi.ts`.

- `cardKind: 'match_proposal'` (in My Agent DM): payload `{ matchId, ownIntent: {id, kind, terms}, otherTerms, otherKind, status }`.
- `cardKind: 'match_status'` (in My Agent DM): payload `{ matchId, status }` — posted on resolution.
- `cardKind: 'match_context'` (in the human DM on connect): payload `{ matchId, askTerms, offerTerms }` — neutral copy, e.g. "Your agents matched an ask and an offer. Ask: … / Offer: …". No instruction to either party, no auto-opener.

Client rendering (mobile `ChatScreen.tsx` ~line 1380-1443 branch; web `MessageList.tsx` ~line 384-456 branch):
- Cards render as neutral centered/system-style bubbles with **no sender attribution** (clients must not require the sender to be a conversation participant for `messageType:'card'`).
- `match_proposal` cards show Approve / Decline buttons wired to the respond endpoint; after responding (or on `alreadyResolved`) the card shows its resolved state locally.
- Unknown `cardKind` → render fallback: generic "Update from your agent" bubble (forward compatibility).
- Both clients ship in the same session (mandatory parity rule; RN-web export covers `/m` + `/d`).

## REST API (all under `resolveActor` — JWT *and* `oc_` agent keys; this IS the provider-neutral seam)

- `POST /api/intents` `{kind, terms, details?, expiresAt?}` → `201 {intent}`. Validation: kind ∈ {ask, offer}; terms 1–500 chars; details ≤ 2000; optional expiry is a future date-time.
- `GET /api/intents` → own intents (all fields).
- `PATCH /api/intents/:id` `{status:'withdrawn'}` (owner only) → withdraw from discovery. (Editing terms = withdraw + republish; keeps matching semantics trivial.)
- `GET /api/matches` → matches involving the caller's intents, per-viewer projection ONLY: `{id, status, ownIntent{id,kind,terms}, otherKind, otherTerms, createdAt, updatedAt}`.
- `POST /api/matches/:id/respond` `{decision: 'approve'|'decline'}` → per-viewer projection (+ `conversationId` when it becomes `connected`; + `alreadyResolved` when applicable).
- OpenAPI (`apps/server/src/openapi.ts`) documents all five, so the existing ChatGPT Custom-GPT-Action path picks them up from `/api/openapi.json` for free.

**Hard privacy rule:** no response payload for a non-owned intent may ever include `ownerUserId`, name, email, avatar, source conversation/message ids, or `details`. Enforced by projection at the query layer and asserted by tests.

## Hosted Assistant integration (`apps/server/src/services/assistant.ts`)

New tools in the existing tool-use loop (all call the same service functions as the REST routes, scoped to the triggering `userId`):
- `publish_intent {kind, terms, details?}` — system prompt REQUIRES the assistant to echo the exact anonymous `terms` back to the user and get an explicit confirmation in-chat before calling (publishing is the discovery opt-in; no silent activation).
- `list_intents`, `withdraw_intent {intentId}`
- `list_matches`, `respond_match {matchId, decision}` — the assistant may relay a user's plain-language "yes, connect us" but must confirm before `decline` as well.
System-prompt addition explains asks/offers, anonymity guarantees, and the no-auto-opener rule so the assistant explains the feature accurately.

## MCP + connection bundle (`apps/mcp-server`, docs, setup blobs)

- New tools (thin REST wrappers, same names/shapes): `oc_publish_intent`, `oc_list_intents`, `oc_withdraw_intent`, `oc_list_matches`, `oc_respond_match`. Graceful 404 fallback message if the server predates the endpoints (existing pattern in `oc_register_agent`).
- Update `apps/mobile/src/utils/agentSetupBlob.ts` + `apps/web/src/utils/agentSetupBlob.ts` (they are hand-mirrored) to mention the intent endpoints, so the existing copy/paste bundle (tool-less REST blob, Custom GPT Action via OpenAPI, and per-client stdio MCP snippets in `McpSetupCard`) covers asks/offers.
- Docs: extend `docs/connect-your-bot.md` with an "Asks & offers via your own agent" section. Explicitly state the boundary: external agents *poll/act via MCP/REST when their user runs them*; OpenChat pushes to services via outbound webhooks; **OpenChat cannot and does not call into a consumer ChatGPT/Claude chat session.**
- Explicit non-goals for M1: no hosted `/mcp` HTTP endpoint, no OAuth/DCR, no npm publish, no scope enforcement change (all remain documented gaps / follow-ups).

## Acceptance tests (in `apps/server/test/`, following existing patterns)

Unit (pure, no DB — like `secretary.test.ts`):
1. Scoring: ask matches complementary offer above threshold; same-kind pairs never match; same-owner pairs never match; below-threshold pairs never match.
2. State machine: proposed→(approve,approve)→connected; proposed→(decline)→closed; idempotent re-respond; declined pair never re-proposed.
3. Per-viewer projection: never leaks other side's response state, ownerUserId, or details.

Route tests (mocked driver — like `chatUnread.route.test.ts`):
4. Intents CRUD auth: no auth → 401; agent key (`oc_`) accepted; validation errors → 400; withdraw by non-owner → 404/403.
5. Respond endpoint: approve/decline flows, `alreadyResolved` behavior.

Integration (env-gated real Neo4j — like `chatUnread.integration.test.ts`, `describe.skip` without `NEO4J_TEST_URI`):
6. **The two-user loop:** A publishes ask, B publishes offer → match proposed → A's and B's match views contain the other's terms and kind but NO name/id/email/details → both approve → exactly one DM exists between A and B (created or reused if one already existed) containing exactly one `match_context` card and no other new messages → intents and match are `connected`.
7. **Decline path:** B declines → match `closed`, no DM created, A's view shows `closed` with no decliner identity, both intents still `active`.
8. **DM reuse:** pre-existing A↔B DM → connect does not create a duplicate conversation (dedup helper reused).

Gates: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test` at root must pass. Also fix `apps/server/.env.example` to document `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ASSISTANT_MODEL`, `INTENT_MATCH_THRESHOLD`.

## Explicit non-goals (M1)

- In-chat agent overlay UI (next milestone, filed separately). Human-visible Stories (deferred).
- Match expiry/cron, mutual-connection computation, notifications/push, group intents, intent editing in place.
- Hosted remote MCP endpoint / OAuth; agent-key scope enforcement (pre-existing documented gap).
- Any reverse "OpenChat invokes your consumer ChatGPT/Claude chat" flow.
