# OpenChat

A monorepo for the OpenChat application.

## OpenChat Surface Map

| Path | What it is | Framework | Ships to | Status / Activity |
|------|-----------|-----------|----------|-------------------|
| `apps/mobile` | Single product client | React Native 0.81.5 + Expo (`react-native-web`) | Native iOS (TestFlight) + Responsive web (`/app`) | **CANONICAL** (High: 63 commits in 60d) |
| `apps/web` | Frozen legacy client | React + Vite (no RN) | Nowhere (migration reference only) | **LEGACY** (Low: 14 cross-cutting commits in 60d) |
| `apps/desktop` | Tauri window around the live `/app` client (same origin/auth/socket; see its README) | Tauri + Rust | macOS `.dmg` via GitHub Releases | **CANONICAL** (active in main) |
| `apps/server` | Shared backend | Node.js / Express + Socket.IO + Neo4j | GCP Prod (see [domain rollout](docs/chat-domain-rollout.md)) | **CANONICAL** (Moderate: 52 commits in 60d) |
| `apps/mcp-server` | Agent tools bridge | TypeScript (Node) | Claude local / connector | **CANONICAL** (Low: 8 commits in 60d) |
| `infra/` | Production deployment | Docker / bash scripts | GCP Prod (Instance `noos`) | **CANONICAL** |

> **Note:** `apps/mobile` is the singular product client for both native mobile and responsive web. `apps/web` is entirely legacy and retained only for history and migration reference.

## Create a World Issue Tracker board

Open **OpenChat Agent** from Chats and ask it to create a public World Issue
Tracker board, giving the board's name and an optional description, location,
or website URL. The agent checks existing boards first so you can reuse a match,
then asks you to confirm the name and attribution before creating it. It returns
the board link, or an existing board when World Issue Tracker reports a duplicate.

You need an OpenChat session, but no World Issue Tracker sign-in. Boards created
by anyone other than the configured account owner are anonymous, public, listed,
and owned by no account. The owner can also explicitly ask to create anonymously;
otherwise creation uses the owner's identity. An owner-attributed failure is
reported without retrying anonymously. This tool offers no unlisted or nudge
settings. Creation shares OpenChat's limit of 30 external writes per user per
hour and is also subject to World Issue Tracker's limits; a remote rate-limit
response includes the retry delay when supplied.
