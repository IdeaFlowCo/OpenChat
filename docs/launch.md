# OpenChat — Launch State (2026-07-11, OpenChat-jmu)

## What OpenChat is now

OpenChat is a real-time messaging app — iOS (TestFlight), Android (APK), mobile
web (`/m`), desktop PWA (`/d`) — built for **you and your agents**, on one Noos
identity shared with the `globalbr.ai` knowledge graph.

Grounded in shipped code, the vision pillars stand here:

| Pillar | Status | Where |
|---|---|---|
| **AI-integrated messaging** | ✅ shipped | Pre-send transforms (NVC, concise, translate) in composer; voice-note transcription |
| **Agent-friendly API** | ✅ shipped | `oc_` agent keys (Settings → Connect an agent, `apps/server/src/routes/agentKeys.ts`), MCP server (`apps/mcp-server`, 6 tools), curl-able REST |
| **Thoughts / memory** | ✅ v1 shipped | Private stream of facts / decisions / commitments / reminders with tags, search, live socket sync (`routes/thoughts.ts`, `ThoughtsScreen.tsx`). AI extraction from chats is designed (`docs/thoughts-design.md`) but not built |
| **Noos identity** | ✅ shipped | Shared JWT SSO with Noos; same Neo4j graph |
| **Shareable human conversations** | ◻ partial | Per-user invite pages (`/u/:id`), QR invites, private conversation export — no public transcript links yet |

## Newly launch-ready in this slice

1. **Landing page at `/`** — the polished marketing/launch surface
   (`apps/server/src/landing.html`, routed at `/` and `/about` since
   OpenChat-e4n) had never been deployed; production `/` still served the
   RN-web app directly. Deploying this slice launches it: hero, platform
   installs (TestFlight / APK / `/m` / `/d`), connect-your-agent snippets, QR.
   Lede now states the full vision (agents + Thoughts + Noos identity).
2. **Agent-ready onboarding** — new final onboarding step ("Built for you and
   your AI") introduces agent keys and the Thoughts stream to every new user on
   native, `/m`, and `/d` (`OnboardingScreen.tsx`, one shared RN codebase, so
   web/mobile parity holds by construction; the legacy `/legacy` client has no
   onboarding flow — documented platform exception).

## What should come next

- **Thoughts v1.1** — LLM extraction from chats ("💭 add to thoughts?"),
  per-conversation opt-in. Design settled in `docs/thoughts-design.md`.
- **Shareable transcripts** — `POST /api/conversations/:id/share-link` → public
  read-only `/shared/<token>` view. Smallest path to the sharing pillar.
- **Path 2 shared bot** — deploy `openchat-agent` per
  `docs/agent-integration-paths.md` (built, never deployed).
- **npm-publish the MCP server** so the install snippet shortens from
  `github:tmad4000/openchat-mcp-server`.
