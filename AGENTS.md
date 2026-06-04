# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## 🔁 Web ↔ Mobile parity (MANDATORY)

OpenChat ships across **two repos that must stay in sync**:

| Repo | What it is | Surfaces |
|------|-----------|----------|
| `IdeaFlowCo/OpenChat` (this repo) | Node/Express + Neo4j **server**, legacy Vite **web** client, and the **deploy host** that `expo export`s openchat-mobile into `/m` and `/d` | `chat.globalbr.ai`, `/legacy` |
| `tmad4000/openchat-mobile` (`~/code/openchat-mobile`) | React Native / Expo app | native iOS (TestFlight) + RN-web at **`/m`** (mobile web) and **`/d`** (desktop web) |

**Rule: any user-facing chat change you make in one repo, you must also make in the other**, in the SAME work session, so native and web never drift. This includes composer behavior, send/receive, auth flows, message rendering, presence, etc. The backend is shared (one server), so server changes cover both — but **client changes do NOT cross repos automatically**.

- After changing a feature here, ask: "does `openchat-mobile` have the same surface?" If yes, port it (and vice versa). `deploy.sh` rebuilds `/m`,`/d` from `~/code/openchat-mobile`, so a web deploy ships whatever is committed there.
- **Platform-appropriate exceptions are fine** (just document them): e.g. Enter-to-send is **web-only** — on a native touch keyboard the return key stays a newline and sending is the send button. No hardware-keyboard Enter handling is needed.
- Standing tracker: epic **openchat-3jq** ("keep web/mobile in sync").

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
