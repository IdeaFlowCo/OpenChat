# OpenChat agent-first social layer

**Status:** implementation contract, 2026-09-02
**Tracker:** `OpenChat-x2f3`
**Baseline:** `archive/pre-stories-2026-09-02` (pushed before implementation)

## Product boundary

OpenChat remains a chat app. Coordination is a layer inside the same responsive
client, not a second network or a second application. **Chat + coordination** is
the default experience; **Simple chat** hides Stories, Asks, review badges, and
special agent launchers without deleting data. My Agent remains an ordinary
private chat in both modes. Switching to Simple explicitly offers to keep or
pause active network searches.

## Golden loop

1. A person tells My Agent something in ordinary language. The message and any
   derived intention start private.
2. My Agent returns a structured card containing a goal, what the person seeks,
   what they bring, and a matching mode. It shows that nothing has been shared.
3. The person can **Search quietly**, **Keep private**, **Share with people…**,
   or edit. The first approval controls agent visibility; the second path opens
   an exact human Story preview.
4. Agents match fulfillment, reciprocal exchange, or an opted-in shared goal.
   Identity remains hidden until both people approve a proposed connection.
5. A successful double opt-in creates or reuses a normal OpenChat DM. A Story
   response also opens a private DM; declines and non-responses are never public.

This supports both “I need a ticket / I have an extra ticket” and symmetric
cases such as “technical founder seeking distribution founder / distribution
founder seeking technical founder.” `seeks + brings + matchingMode` is the
canonical model; Ask/Offer is only a compatibility projection.

## Human and agent visibility

| Choice | Human visibility | Agent visibility |
|---|---|---|
| Keep private | Owner only | Owner's agent only |
| Search quietly | None | Minimum approved matching terms within the eligible network |
| Share with people | Exact Story shown only to selected people/groups | Their agents may also process the same projection |
| Approve intro | Identity revealed only after both approvals | Match state becomes connected |

Every human Story requires a concrete audience and expiry; there is no global
audience shortcut. Direct capture and inferred drafts can never publish a human
Story automatically. Story expiry and quiet-search expiry are independent.

## App surfaces

- **Chats** stays home. In enhanced mode, My Agent is pinned and a collapsible
  Stories rail appears below the header. The rail includes Share and Agent picks
  so nobody must browse every Story.
- **My Agent** opens over the current context. Natural-language chat is primary;
  forms are secondary editing tools.
- **Review** contains only decisions: private activation suggestions, possible
  matches, and expiring activity. Passive memory does not inflate its badge.
- **Asks** is the person's inventory of private drafts, quiet searches, human
  Stories, offers, resources, and shared goals.
- **Stories** are human-readable projections, styled as Ink & Paper index cards.
  Reply, I may be able to help, and Ask My Agent all remain private actions.

## Personal-agent architecture

The OpenChat-hosted Assistant is the default agent provider for people who do
not yet run one. It is an API-backed assistant inside the user's private My
Agent DM, not a coding agent. Personal agents remain first-class: an OpenChat
agent key plus MCP or the copy/paste REST setup lets Claude, ChatGPT, Codex,
Cursor, Cortex, or a machine-local agent act as that user. Both paths operate on
the same conversations, private drafts, Stories, matches, and approvals.

## Volume and safety

Hundreds of latent asks/resources are private memory, not hundreds of active
posts. Repeated evidence should merge into a living intention; stale items
decay; active quiet searches are budgeted; sensitive or third-party facts always
require manual approval. Production enablement requires audience enforcement,
blocking, export, deletion, redaction, and double-approval tests to remain green.
