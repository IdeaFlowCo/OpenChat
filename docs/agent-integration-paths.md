# Agent integration paths — decision pending

> **Status:** revised 2026-06-01 after Codex second opinion. Three different
> ways for an "agent" to talk to OpenChat exist. Paths 2 and 3 cover
> **different use cases** and should both ship. Path 1 (picortex) is the
> legacy implementation of path 2; it gets retired after path 2 deploys.
> Captured here so the discussion does not get re-litigated.

## TL;DR

Three paths exist; **two are kept (different use cases)**, one is retired:

| # | Path | Identity model | Use case | Status | Verdict |
|---|---|---|---|---|---|
| 1 | **picortex** (`~/code/picortex`, deployed on picortex-v1 GCP VM) | One shared bot user `picortex_bot_7ecd2883dbd5ceef` in Neo4j | "Shared assistant in our group, responds to @mentions" | Running in production. @mention triggers a reply. | **Retire** after path 2 deploys. Legacy multi-channel baggage (Linq + Element). |
| 2 | **openchat-agent** (`~/code/openchat-agent`) | Same shared bot user as picortex | **Same use case as picortex** — shared room-level participant | Built 2026-05-31 morning, never deployed. ~450 SLOC, OpenChat-native, no Linq baggage. | **Deploy** on a fresh isolated VM. Replaces picortex's OpenChat slice. |
| 3 | **openchat-mcp-server** + agent API keys | Per-user `oc_…` key. Agent acts AS the user. | "MY agent uses MY chats when I ask it to" — single-user, on-demand | Shipped 2026-06-01. GitHub: <https://github.com/tmad4000/openchat-mcp-server>. In-app UI in `AgentKeysScreen`. | **Canonical for per-user integration.** Complementary to path 2, not a replacement. |

## Why both 2 and 3 (corrected — earlier draft was wrong)

The original 2026-06-01 draft of this doc said path 3 superseded path 2 and
recommended archiving openchat-agent. That was wrong. The Codex review at
`/tmp/codex-agent-paths-review/ANSWER.md` corrected the framing:

- **Path 3 (MCP)** = "my agent reads/sends MY chats when I prompt it." Single
  user. Requires the user to install an MCP client (Claude Desktop, Cursor,
  etc.), mint a key, paste config. Agent acts as that user, can only do
  things the user can do.
- **Path 2 (shared bot)** = "there is a participant in this room that anyone
  can address, with no per-user setup." Stable room-level actor with a
  distinct identity. Group-scoped operator. Doesn't make any individual user
  the "operator, credential holder, and failure domain" for the room's bot.

A user running an MCP agent in "listen mode" does NOT substitute for the
shared bot. It collapses the room-level affordance into one user's machine.

These are two products, not two implementations of one product. Both stay.

## How we got here (timeline)

### 2026-05-31 06:33–06:53 PT — "picortex is overkill" audit

Codex audit (driven by Jacob) of picortex's surface area asked:

1. What runs when a human @mentions picortex in an OpenChat group?
2. Of picortex's mass (ConsentBroker, manifest events, SQLite store,
   LinqChannel, attention state machine), what is actually needed for
   OpenChat vs. only for the Linq integration?
3. What would a fresh "OpenChat AI agent with tools" look like without
   picortex?
4. Migration path: (a) keep as-is (b) extract subset (c) write fresh.

**Conclusion: write fresh.** A builder agent shipped `~/code/openchat-agent/`
— 8 TypeScript files, **~450 non-comment SLOC** (vs. picortex's multi-thousand).

What was kept from picortex:
- websocket-only socket.io transport (Cloudflare drop-fallback gotcha, verified 2026-04-23)
- per-conversation `conversation:join` gating
- self-message dedupe at the socket layer

What was dropped:
- ConsentBroker, LinqChannel, ReactionHandler
- Manifest/privacy-consent gating
- Attention-mode state machine
- SQLite store (chat history re-read from REST per turn)
- Streaming responses, tool calling (TODOs left)

Repo built, typechecks clean, smoke tests pass. **Never deployed.**

### 2026-05-31 12:15 PT — flip-flop ("openchat-agent is now redundant")

In a monorepo review later the same day, Claude (me) wrote:

> "`openchat-agent` is now redundant. Picortex (just pushed) is the real
> version of 'extract the bot into its own thing.' I'd recommend deleting
> `~/code/openchat-agent`."

This **directly contradicts the morning's conclusion** and was never
reconciled. Logged here to make sure the contradiction is visible.

### 2026-06-01 — MCP path shipped

Per-user agent API keys (`oc_…` prefix, AES-256-GCM at rest, re-viewable)
shipped as `OpenChat-7c9`. The OpenChat MCP server shipped alongside as
a thin REST→MCP adapter. Six tools: `oc_list_conversations`,
`oc_get_messages`, `oc_send_message`, `oc_react`, `oc_create_dm`,
`oc_register_agent`.

This is a fundamentally different identity model from paths 1 and 2.
Instead of a shared bot user that anyone can @mention, each user mints
their own key and connects their own MCP client. The agent acts AS the
user, with the user's permissions.

## API key vs. MCP — different layers

These are not the same thing. They are different layers of the stack:

```
┌─────────────────────────────────────────────────┐
│  Claude Desktop / Cursor / Codex CLI / etc.     │  ← LLM client
└─────────────────────────────────────────────────┘
                       ⇅  (MCP protocol, stdio or HTTP)
┌─────────────────────────────────────────────────┐
│  openchat-mcp-server (npx … or local install)   │  ← adapter
└─────────────────────────────────────────────────┘
                       ⇅  (REST + Bearer auth)
┌─────────────────────────────────────────────────┐
│  https://chat.globalbr.ai/api/* — OpenChat REST │  ← server
└─────────────────────────────────────────────────┘
                       ⇧
              Authorization: Bearer oc_…  ← API key
```

- **The API key (`oc_…`)** is the *credential*. It is a Bearer token.
  It authenticates HTTP requests against OpenChat's REST API. You can
  use it from anything: `curl`, a Python script, a cron job, the MCP server.
- **MCP** is a *protocol* for letting LLM clients call "tools." Our MCP
  server is a small adapter (~600 lines) that receives MCP tool calls
  from a client, translates them to REST calls against OpenChat (using
  the same `oc_` key), and returns the result.

So:
- Have `oc_` key, want to write a script → use REST directly, ignore MCP entirely
- Have `oc_` key, want Claude Desktop to read your chats → drop the key into
  Claude Desktop's MCP config, and the MCP server bridges the two

The API key is the bedrock. MCP is one of many possible surfaces on top.

## Is MCP overkill / underkill / just right?

**Just right for "LLM client wants to read or send messages on your behalf
when you ask it to."** Friction is essentially zero (paste a JSON snippet,
done), the tool catalog is auto-discovered by the LLM, and it works across
every MCP-aware client without per-client glue code.

**Overkill for headless bots / cron-style scripts.** If you are writing
a Python script that wakes up every hour and posts a status update, the
MCP server adds nothing — just hit the REST API directly with the same
`oc_` key. We have not (and should not) force MCP on this use case.

**Underkill for true real-time agent participation.** MCP is request /
response. If you want an agent that *listens* on a WebSocket and reacts
to messages as they arrive (the picortex model), MCP's tool-call shape
is awkward. You can fake it ("`oc_long_poll`" returning chunks), but
the right tool is a direct WebSocket connection with bot-JWT auth.

### Where each path is right

| Use case | Right surface |
|---|---|
| "Claude in my menu bar can summarize / reply to my chats" | **MCP via API key** |
| "Headless script that posts a daily summary to a group" | **REST directly via API key** |
| "Bot that listens for @mentions in real time and replies" | **WebSocket + bot JWT** (picortex model) |
| "Agent runs my desktop and uses OpenChat as one of many tools" | **MCP via API key** |

### Why we layered it this way

The API key is universal. Every path above uses the same `oc_…` key
(except picortex which uses a long-lived JWT minted out-of-band — that's
the legacy quirk we should fix). On top of the key, you pick the protocol
that fits the use case. MCP is *one* protocol. We default to recommending
it because it covers the common case (LLM-client-driven agents) with
zero glue code, but we do not require it.

## Proposed decision (revised after Codex review)

1. **`openchat-mcp-server` is the canonical per-user integration path.**
   For "MY agent uses MY chats." In-app Settings → Agent keys flow + the
   MCP snippets in `AgentKeyDetailScreen` already point users at this.
2. **`openchat-agent` is the canonical shared-bot path.** Deploy on a
   **fresh isolated GCP e2-micro** (~$5/mo). Reuses
   `picortex_bot_7ecd2883dbd5ceef` Neo4j identity + JWT. Tracked in
   `OpenChat-p9y` (reconsider) and the deploy ticket spawned from it.
   - **Why GCP e2-micro, not testcortex:** testcortex is on Jacob's
     Tailscale network. Even with no shell tools today, agent capabilities
     tend to grow; the right place to draw the security boundary is
     before deploy, not after a compromise.
   - **Why not co-host on picortex-v1:** defeats the isolation that
     justifies retiring picortex.
3. **picortex** runs as a temporary bridge until `openchat-agent` is
   deployed and verified against the same bot identity. Then stop
   picortex's OpenChat participation and decommission the picortex
   GCP VM (target: ~2 weeks after openchat-agent deploys, not
   2026-09-01 anymore).
4. **Tool calling for the shared bot** is designed as explicit bot
   capabilities (group-scoped operator, bounded actions, policy enforced
   at the bot level — not inherited from any user's MCP client). Filed
   as a follow-up ticket after openchat-agent v1 deploys.
5. If a use case appears that fits neither pattern (e.g. a per-user
   listening agent that watches all of a user's chats without
   polling), we file a new ticket and most likely add a `listen` scope
   to agent keys + bot-WebSocket auth.

## Open questions

- Does any third party currently depend on picortex's @mention behavior
  in a way that would break if it went away during the cutover?
- Should the MCP server be published to npm as `@openchat/mcp-server` so
  the install string is shorter than `npx -y github:tmad4000/openchat-mcp-server`?
- Should agent keys support a `listen` scope (WebSocket subscribe) for
  the "per-user listening agent" pattern from §5 above?
- For the shared bot: keep `picortex_bot_…` identity (preserves history)
  or fresh `openchat_assistant_…` identity (clean slate, no name baggage)?
