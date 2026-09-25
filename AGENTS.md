# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Build & Test

Run project-wide checks from the monorepo root. The root `packageManager` pins
npm so Turborepo can resolve workspace tasks consistently.

```bash
npm ci
npm run lint
npm run typecheck
npm run build
```

Mobile render regressions also run in the server's Vitest suite:
`npm run test --workspace=apps/server` (see `apps/server/test/groupOpen.mobile.test.ts`).

## Canonical client surface

**MONOREPO (since 2026-06-04):** everything lives in this one repo, `IdeaFlowCo/OpenChat`:

| Path | What it is | Framework | Ships to | Status / Activity |
|------|-----------|-----------|----------|-------------------|
| `apps/mobile` | Single product client | React Native 0.81.5 + Expo (`react-native-web`) | Native iOS (TestFlight) + Responsive web (`/app`) | **CANONICAL** (High: 63 commits in 60d) |
| `apps/web` | Frozen legacy client | React + Vite (no RN) | Nowhere (migration reference only) | **LEGACY** (Low: 14 cross-cutting commits in 60d) |
| `apps/desktop` | Tauri window around the live `/app` client (same origin/auth/socket; see its README) | Tauri + Rust | macOS `.dmg` via GitHub Releases | **CANONICAL** (active in main) |
| `apps/server` | Shared backend | Node.js / Express + Socket.IO + Neo4j | GCP Prod (`chat.globalbr.ai/api/*`) | **CANONICAL** (Moderate: 52 commits in 60d) |
| `apps/mcp-server` | Agent tools bridge | TypeScript (Node) | Claude local / connector | **CANONICAL** (Low: 8 commits in 60d) |
| `infra/` | Production deployment | Docker / bash scripts | GCP Prod (Instance `noos`) | **CANONICAL** |

(The old separate `tmad4000/openchat-mobile` repo is **frozen/archived** — its history is in `apps/mobile`.)

**Rule: `apps/mobile` is the single product client.** User-facing changes belong
there and reach native, phone web, tablet web, and desktop web through the
responsive layout. Do not mirror new work into `apps/web`; it is retained only
for history and migration reference. The backend (`apps/server`) is shared.
`infra/deploy.sh` builds the one `/app` RN-web export; `/m`, `/d`, and `/legacy`
redirect to `/app` while preserving the remaining path and query.
- **Platform-appropriate exceptions are fine** (just document them): e.g. Enter-to-send is **web-only** — on a native touch keyboard the return key stays a newline and sending is the send button. No hardware-keyboard Enter handling is needed.

## Theme tokens (`apps/mobile/src/theme/`)

`palette.ts` holds the raw "Ink & Paper" values and **must stay free of
`react-native` imports** — that is what lets `contrast.test.ts` assert WCAG
ratios directly. `colors.ts` only resolves the scheme (`getColors`).

Pick the token by role, not by how it looks:

| Token | Use for |
|---|---|
| `onPrimary` | Any text/icon/spinner painted on `primary`. Never hardcode white — white fails on dark-mode sienna (3.15:1). |
| `textMetadata` | Small text a user must read: timestamps, counts, status, labels, explanatory copy, empty states. |
| `textMuted` | Decoration and disabled only — chevrons, dividers, `placeholderTextColor`. Deliberately below 4.5:1. |

`contrast.test.ts` fails the build if these drift, so add new opaque pairs there
rather than eyeballing them.

Chat headers (compact native-stack, embedded/desktop) share
`components/ConversationHeaderContent.tsx`: a shrinking identity column
(`flex:1`/`minWidth:0`, one-line tail ellipsis) plus a fixed-width action
column. Keep secondary actions in the More menu so the action column's width
never changes with state, and keep state text in the subtitle
(`utils/conversationHeader.ts`). Safe-area inset has exactly one owner —
`useHeaderHeight()` already includes `insets.top`.

## 🚀 Deploy when done (STANDING RULE — Jacob, 2026-06-04)

When you finish a chunk of work, **deploy both** without asking each time:

1. **Web / server / `/app`:**
   ```bash
   cd ~/code/OpenChat && bash infra/deploy.sh
   ```
   This targets GCE instance `noos` in project `lightsail-migration`, zone
   `us-central1-a`. See `docs/gcp-production.md`. Never use the retired
   Lightsail IP or the unrelated `boreal-conquest-464203-v2/noos-gcp-1` VM.
2. **Native iOS → TestFlight** (bumps version, `eas build --local`, `eas submit`, publishes to testers → Apple Beta review):
   ```bash
   cd ~/code/OpenChat/apps/mobile && TMPDIR="$HOME/.ocbuild-tmp" bash scripts/local-build.sh
   ```
   - **Never run `local-build.sh` under tmux.** Use a canonical `TMPDIR` under `$HOME` (the `/tmp` symlink breaks Metro: "Unable to resolve module index.ts"). Node must be v22.
   - The fastlane `exportArchive` step "fails" on macOS Tahoe (openrsync `-E`); the script works around it with a manual IPA zip — that's expected, the build still ships.
   - Signing creds live (gitignored) in `apps/mobile/.credentials/` + `apps/mobile/credentials.json`; ASC API key in `~/.appstoreconnect/`.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**
- `bd ready` - Find unblocked work
- `bd create "Title" --type task --priority 2` - Create issue
- `bd close <id>` - Complete work
- `bd sync` - Sync with git (run at session end)

For full workflow details: `bd prime`

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
