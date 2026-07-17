# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## 🔁 Web ↔ Mobile parity (MANDATORY)

**MONOREPO (since 2026-06-04):** everything lives in this one repo, `IdeaFlowCo/OpenChat`:

| Path | What it is | Surfaces |
|------|-----------|----------|
| `apps/server` | Node/Express + Socket.io + Neo4j **server** (shared backend) | `chat.globalbr.ai/api/*` |
| `apps/web` | Vite/React **web** client (legacy) | `chat.globalbr.ai/`, `/legacy` |
| `apps/mobile` | React Native / Expo app | native iOS (TestFlight) + RN-web at **`/m`** (mobile web) and **`/d`** (desktop web) |
| `apps/desktop` | Tauri desktop wrapper around the `apps/mobile` RN-web export | native desktop shell |
| `apps/mcp-server` | MCP REST→tools bridge (Claude-side connector) | run locally / connect to Claude |
| `infra/` | `deploy.sh`, `docker-compose.prod.yml`, `Dockerfile` | prod deploy |

(The old separate `tmad4000/openchat-mobile` repo is **frozen/archived** — its history is in `apps/mobile`.)

**Rule: any user-facing chat change in one client (`apps/web` / `apps/mobile`) must be mirrored in the other in the SAME session** so native and web never drift (composer, send/receive, auth, rendering, presence…). The backend (`apps/server`) is shared, so server changes cover both. `infra/deploy.sh` rebuilds `/m`,`/d` from `apps/mobile`.
- **Platform-appropriate exceptions are fine** (just document them): e.g. Enter-to-send is **web-only** — on a native touch keyboard the return key stays a newline and sending is the send button. No hardware-keyboard Enter handling is needed.
- Standing tracker: epic **openchat-3jq** ("keep web/mobile in sync").

## 🚀 Deploy when done (STANDING RULE — Jacob, 2026-06-04)

When you finish a chunk of work, **deploy both** without asking each time:

1. **Web / server / `/m` / `/d`:**
   ```bash
   cd ~/code/OpenChat && bash infra/deploy.sh
   ```
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
