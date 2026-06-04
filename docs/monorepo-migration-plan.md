# OpenChat Monorepo Migration Plan (openchat-3jq.5)

**Status:** DRAFT for review — do not execute until Jacob approves. Authored 2026-06-04.
**Goal:** One workspace where server, web client, the Expo app, shared API client, shared types, and deploy/EAS scripts are versioned together — so a protocol change lands in one PR instead of drifting across two repos.

## 1. Current state (the problem)

Two independent git repos:

| Repo | Contains | Deploys to |
|---|---|---|
| `~/code/OpenChat` | npm workspaces `server` + `client` (Vite web), plus `client-mobile` / `client-mobile-desktop` RN-web export dirs for `/m` and `/d`, Dockerfile, `deploy.sh` | `chat.globalbr.ai` (backend + web) |
| `~/code/openchat-mobile` | Expo SDK 54 / RN 0.81 native app (`App.tsx`, `src/`, `ios/`), `eas.json`, `scripts/local-build.sh` | TestFlight (iOS) + web exports mounted at `/m`, `/d` |

**Drift hot-spots (verified):**
- **API client duplicated:** `OpenChat/client/src/api.ts` ↔ `openchat-mobile/src/api/client.ts`. Endpoints, auth/refresh logic, and socket wiring are re-implemented in both.
- **Types duplicated:** message/conversation/user shapes are hand-redeclared on web, mobile, and server (Neo4j projections).
- **No shared protocol source:** the `text`→`content` alias, self-DM rules, agent-key scopes all had to be edited per-surface (this session hit exactly that).
- The `/m` and `/d` web builds already come from the `openchat-mobile` RN-web export — so the `client-mobile*` dirs in `OpenChat` are partly redundant (overlaps openchat-3jq.4).

## 2. Target layout

Single repo `openchat/` using **npm workspaces + Turborepo** (npm workspaces already in use; add Turbo for task caching/orchestration):

```
openchat/
├── apps/
│   ├── server/        # was OpenChat/server  (Express + Socket.io + Neo4j)
│   ├── web/           # was OpenChat/client  (Vite SPA)
│   └── mobile/        # was openchat-mobile   (Expo app; emits native + /m,/d web)
├── packages/
│   ├── api-client/    # ONE typed REST+socket client, consumed by web + mobile
│   ├── types/         # shared Conversation/Message/User/AgentKey/scopes
│   └── protocol/      # route paths, field aliases (content|text), event names
├── infra/
│   ├── Dockerfile, docker-compose.prod.yml, deploy.sh
│   └── eas.json, scripts/local-build.sh, publish-to-testers.py
├── package.json       # workspaces: ["apps/*","packages/*"]
├── turbo.json
└── .github/workflows/ # CI: typecheck/build/test; EAS build+submit (3jq.2)
```

## 3. Migration order (incremental, each step independently shippable)

**Phase 0 — Pre-flight (coordination gate).**
- All in-flight branches across both repos merged to their mains (esp. the `dock-operation` agent's chat.ts/socket work). Migration MUST start from a clean, merged main on both repos or history-join gets ugly.
- Freeze new feature branches for the migration window (short — it's mechanical).

**Phase 1 — Create the monorepo shell, preserve history.**
- New repo (or reuse `OpenChat`) with `apps/` + `packages/`.
- Bring both repos in with **history preserved** via `git subtree add --prefix=apps/mobile <openchat-mobile remote>` (and move existing `server`/`client` → `apps/server`/`apps/web` with `git mv`). Subtree (not submodule) so it's one working tree.
- Root `package.json` workspaces `["apps/*","packages/*"]` + `turbo.json`. `npm install` once at root.

**Phase 2 — Extract `packages/types` + `packages/protocol`.**
- Move the canonical message/conversation/user/agent-key types into `packages/types`; re-export from server/web/mobile, deleting the duplicates one surface at a time (typecheck after each).
- `packages/protocol`: route constants, the `content|text` alias, socket event names. Server + clients import these instead of string literals.

**Phase 3 — Unify the API client into `packages/api-client`.**
- Diff `client/src/api.ts` vs `mobile/src/api/client.ts`; build one client parameterized by platform bits (storage, fetch, socket impl) injected by each app. Mobile keeps `expo-secure-store`; web keeps localStorage — via a small adapter interface.
- Swap web + mobile to consume `@openchat/api-client`. Delete both originals.

**Phase 4 — Collapse `/m` and `/d`** (folds in openchat-3jq.4): single responsive RN-web export from `apps/mobile`; drop `client-mobile*` from the old layout.

**Phase 5 — Infra + CI.**
- `deploy.sh`/Docker build `apps/server` + `apps/web`. `eas.json`/`local-build.sh` run from `apps/mobile` (keep the TMPDIR + Node self-heal from openchat-u0k).
- GitHub Actions: turbo `typecheck`/`build`/`test` on PR; EAS build+submit workflow (openchat-3jq.2).

## 4. Risks & mitigations
- **History join messiness** → use `git subtree` (preserves history, single tree); tag both repos pre-migration for rollback.
- **EAS expects app at repo root** → Expo supports monorepos, but `eas.json`, `metro.config.js` (watchFolders → repo root + symlink resolution), and `.xcode.env` need monorepo-aware paths. Budget a throwaway EAS build to validate before cutover.
- **Two deploy targets, one repo** → path-filtered CI so a web-only change doesn't trigger an iOS build.
- **Beads** lives in `OpenChat/.beads` — keep it at the monorepo root; reconcile the `openchat-`/`OpenChat-` prefix split (openchat-yci) during the move.
- **Other agents** mid-edit → Phase 0 gate is mandatory; announce a short freeze.

## 5. Effort
A few focused sessions: shell+history (one session), types+protocol (one), api-client unify (one, the meatiest), /m,/d collapse + infra/CI (one). Sequence them; each leaves both apps building. Bottleneck is review + the EAS monorepo validation build, not agent time.

## 6. Decisions needed from Jacob before execution
1. Reuse `OpenChat` repo as the monorepo root, or create a fresh `openchat` repo?
2. Turborepo (recommended) vs plain npm workspaces only?
3. OK to schedule a short "no new branches" freeze window across both repos for the cutover?
