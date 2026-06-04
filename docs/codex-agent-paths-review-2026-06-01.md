# Codex second opinion — agent integration paths (2026-06-01)

Source: codex-cli 0.135.0, codex-codebase-plus-conversation pattern
Working dir: /tmp/codex-agent-paths-review/
Question context: QUESTIONS.md
Files Codex read: agent-integration-paths.md, openchat-agent-README.md, openchat-mcp-server-README.md

---

# Q1

Frame #3 is right. `openchat-agent` and the MCP path are different products, not two implementations of the same product. MCP is "my agent can use my OpenChat account when I ask it to." `openchat-agent` is "there is a shared participant in the room that anyone can address, with no client setup and no ownership ambiguity."

The shared-bot use case does not disappear just because every user could run an MCP agent. A per-user MCP agent speaks as that user, depends on that user's client/config/runtime, and is not a stable room-level actor. A shared bot has a distinct identity, shared affordance, shared memory/policy surface if added later, and uniform availability to everyone in the group. "One user runs an agent in listen mode" is not equivalent; it makes that user the operator, credential holder, and failure domain.

# Q2

If the shared-bot use case stays, `openchat-agent` should be the implementation, not picortex's OpenChat slice. The 2026-05-31 conclusion still holds architecturally: picortex carries Linq-era machinery that is irrelevant to OpenChat, while `openchat-agent` is a small OpenChat-native service that keeps the useful pieces: websocket transport, conversation join gating, self-message dedupe, mention-only group behavior, and REST transcript fetches.

The deployment fact changes sequencing, not the target. Because picortex is already running, keep it only as a temporary compatibility bridge. Do not treat "operational cost = 0 today" as a reason to preserve the wrong architecture indefinitely; it is only a reason not to rush a risky cutover. Since both use `picortex_bot_7ecd2883dbd5ceef`, the clean path is to deploy `openchat-agent` against the same identity, verify behavior, then turn off the picortex OpenChat role.

# Q3

The most defensible place to run the shared bot is a fresh isolated VM: option (c), GCP e2-micro. It is cheap enough, keeps the bot out of Jacob's personal Tailscale environment, avoids co-tenancy with picortex, and makes the security boundary legible.

Do not run it on testcortex. Even if v1 has no shell tools, the whole point of an agent host is that capabilities tend to grow. Co-hosting on `picortex-v1` is acceptable only as a short migration step.

# Q4

Yes. Tool calling is the missing angle that makes the shared bot more distinct, not less. With tools, the shared bot becomes a group-scoped operator: something a room can ask to perform bounded actions, post results back, and enforce a common policy.

That strengthens the case for `openchat-agent` as a separate, minimal, auditable service on its own host. MCP remains the right surface for personal tools; shared bot tool calling should be designed as explicit bot capabilities, not accidentally inherited from some user's MCP client.

# Q5

Recommendation: choose option (d): keep MCP as the canonical per-user integration, deploy `openchat-agent` as the canonical shared-bot implementation on a fresh isolated VM, and retire picortex after the cutover. Do not archive `openchat-agent`. Do not keep all three indefinitely.

Concrete path: leave picortex running only until `openchat-agent` is deployed and observed with the existing bot identity. Then stop picortex's OpenChat participation and decommission the picortex dependency. MCP should remain documented as the default path for "my agent uses my chats"; `openchat-agent` should be documented separately as the path for "our group has a shared assistant."
