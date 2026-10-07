# Context implementation audit · 2026-10-06

> **Delivery update, 2026-10-07:** The audit below records the earlier state.
> PR141 (with deployment configuration in PR142) has now shipped attributed
> threaded replies, editing, tombstones, search/report, refresh and account-safe
> caching, explicit Note/Ask/Offer controls, and bounded opt-in agent request
> polling with atomic replies. See [current Context behavior](context-backchannel.md).
> The shared OAuth connector and setup hub are live at
> [id.ideaflow.app/agents](https://id.ideaflow.app/agents); see
> [the adapter contract](ideaflow-unified-connector.md) and
> [setup placement](agent-connection-entry.md).
>
> Hosted autonomous execution, private-data approval UI, external webhooks,
> Asks/Stories lifecycle reconciliation and unified chat Stream/Context reads
> remain follow-ups. Custom remote MCP works through the shared connector;
> a published ChatGPT directory listing and actual dot-host acceptance remain
> separate from the production OAuth/API verification.

## Historical findings before PR141

Context is a working quiet per-conversation post feed, **not the completed
agent back-channel described by the earlier reviews**. PR #77 shipped a
subset of Phase A. PR #139 repairs existing-key authorization, request errors,
Context editing, and repeatable key/setup copying; it does not finish the
remaining agent coordination product.

## Earlier reviews checked

- September 20 product brief: `~/memory/planning/openchat-context-lane-2026-09-20.md`.
- Astra implementation review: `~/code/firstmate/data/oc-context-lane-plan/report.md`.
  Phase A was independently shippable; Phase B was explicitly the complete v1.
- September 25 design consult:
  `~/memory/planning/openchat-context-vs-thoughts-and-backchannel-2026-09-25.md`.
  It proposed unifying chat-scoped durable content and agent replies. It was
  labeled design-only; its naming/layout suggestions are not a shipped design.
- Firstmate build receipt links PR #77 (`2b62d2e` on main). The current source
  was checked after PR #139 (`51dd2b5`).

## Shipped versus remaining

| Capability | Current implementation |
| --- | --- |
| Quiet notes in direct/group conversations | Present. `ContextLane`, `ContextComposer`, four Context REST routes. The service writes Thought nodes without message/push/socket delivery. |
| Same existing agent key for Chat and Context | Fixed in #139. Membership plus live read/write scopes, revocation, expiry and ownership checks. The unused extra grant requirement was removed at Jacob's explicit direction; old review instructions requiring a separate grant are superseded. |
| Create/read/edit/delete and retry | REST supports these; create/read/delete also have MCP tools. Production HTTP lifecycle verified with isolated fixtures, then removed. App exposes note creation and own-post deletion; edit/reply controls are still missing. |
| Read state separation | Chat screen and chat context track the active lane; opening Context does not use the ordinary visible-Chat read path. This audit did not run the full historical multi-user quiet-delivery matrix. |
| Threaded replies and attribution | `replyToId`/`REPLIES_TO` exist in the API, but the UI is a flat list with text and timestamp. No rendered author/agent identity or threaded reply composer. Current post projection has authorId, not an agent attribution model. |
| Ask/Offer product behavior | API accepts kind, but the app posts notes. No Context ask lifecycle tied to AgentIntent, expiry/renew/close flow, or private help-response inbox. Existing Asks/Stories elsewhere are separate. |
| Agent-to-agent coordination | External agents can explicitly read/post. No Context ask-created wake fan-out, hosted Assistant Context turn loop, external Context webhook, or scoped private-data approval loop. Posting does not automatically summon the other participants' agents. |
| Unified conversation memory | Not shipped. Context and the chat Stream remain separate reads/screens. Personal Thoughts has since been renamed Stream; the September 25 proposed name change should not be treated as settled. |
| Remaining Phase A completion | Search, Context-specific report UX, full reply/edit controls, safe authored projection, and stale-session/conversation cache verification still need work. Do not call all of Phase A complete merely because #77 used that title. |

The September 25 review also proposed changing the lane switch and desktop
layout. Those are separate design choices; the immediate functional gaps are
attribution, replies, reliable refresh, explicit Note/Ask/Offer controls, and
an agent coordination mechanism that preserves the quiet contract.

## Recommended execution order

1. Complete the back-channel conversation experience: names/agent attribution,
   reply/edit, refresh and error recovery, account/conversation cache isolation,
   scoped search/report, and real multi-user quiet-delivery checks.
2. Add explicit ask-to-agents coordination with bounded per-participant wakes,
   owner-scoped access, and approval before sharing private information.
3. Reconcile Phase B's typed asks/private responses with the newer lightweight
   ask proposal and existing Asks/Stories; preserve one intention identity.
4. Unify chat Stream and Context reads once their provenance and audience
   semantics are explicit. Keep the personal Stream distinct.

## Dots and quick connection

OpenChat's current MCP adapter uses local stdio and an API key. It is not a
hosted ChatGPT/dot plugin. The dot's quoted refusal is separate from the
Context 403. This audit used Jacob's pasted excerpt; it had no tool access to
the full dot conversation.

Recommended product flow: choose OpenChat (and optionally Unlinked) in a shared
connection hub; authenticate at Ideaflow ID; consent to clear app/scoped
permissions; return to the host; verify with read-only identity/conversation
calls. An already active identity session should avoid repeated sign-in while
preserving host/account authorization. Do not place long-lived API keys in URLs.

Implementation still needed: hosted MCP transport, OAuth resource discovery,
PKCE/token validation and revocation, ChatGPT plugin registration/discovery,
and end-to-end host testing. Reuse the established identity provider. Unlinked
already exposes hosted MCP; its token does not presently authorize OpenChat
messaging. Manual/Hermes keys remain a supported parallel connection method.

Official references checked: [Dots computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
and [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth).
