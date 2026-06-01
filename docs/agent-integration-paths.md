# Agent integration paths — decision pending

> **Status:** unresolved as of 2026-06-01. Three different ways for an
> "agent" to talk to OpenChat exist or have existed. Pick one canonical
> path. Captured here so the discussion does not get re-litigated.

## TL;DR

Three paths exist, only the third is the one I'd ship long-term:

| # | Path | Identity model | Status | Verdict |
|---|---|---|---|---|
| 1 | **picortex** (`~/code/picortex`, deployed on picortex-v1 GCP VM) | One shared bot user `picortex_bot_7ecd2883dbd5ceef` in Neo4j | Running in production. @mention triggers a reply. | **Retire** with a deprecation date |
| 2 | **openchat-agent** (`~/code/openchat-agent`) | Same shared bot user as picortex | Built 2026-05-31 morning, never deployed. ~450 SLOC. | **Archive** — superseded by path 3 |
| 3 | **openchat-mcp-server** + agent API keys | Per-user `oc_…` key. Agent acts AS the user. | Shipped 2026-06-01. GitHub: <https://github.com/tmad4000/openchat-mcp-server>. In-app UI in `AgentKeysScreen`. | **Canonical** going forward |

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

## Proposed decision

1. **`openchat-mcp-server` is the canonical recommended integration path.**
   The in-app Settings → Agent keys flow + the MCP snippets in
   `AgentKeyDetailScreen` already point users at this.
2. **picortex** stays running for backward compat with anyone who has it
   wired into a group's @mentions, but is no longer documented as the
   recommended path. Deprecation date: **2026-09-01** (3 months notice).
   After that date, retire the `picortex_bot_…` Neo4j user and the
   picortex-v1 GCP VM.
3. **openchat-agent** is archived in place (`git mv ~/code/openchat-agent
   ~/code/_archive/openchat-agent-2026-05-31` or equivalent). The repo
   was a valid exercise but its premise — "we need a slimmer shared bot
   user" — was wrong: we don't need a shared bot user at all.
4. If a future "listen in real time" use case appears (a bot that proactively
   reacts to group messages without being @mentioned), we file a new ticket
   to design that and most likely add a new bot-WebSocket auth path that
   reuses the agent-key infrastructure (e.g. an `oc_…` key with a
   `listen` scope).

## Open questions

- Does any third party currently depend on picortex's @mention behavior
  in a way that would break if it went away? (audit before 2026-09-01)
- Should the MCP server be published to npm as `@openchat/mcp-server` so
  the install string is shorter than `npx -y github:tmad4000/openchat-mcp-server`?
- Should agent keys support a `listen` scope (WebSocket subscribe)?
