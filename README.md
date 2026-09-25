# OpenChat

A monorepo for the OpenChat application.

## OpenChat Surface Map

| Path | What it is | Framework | Ships to | Status / Activity |
|------|-----------|-----------|----------|-------------------|
| `apps/mobile` | Single product client | React Native 0.81.5 + Expo (`react-native-web`) | Native iOS (TestFlight) + Responsive web (`/app`) | **CANONICAL** (High: 63 commits in 60d) |
| `apps/web` | Frozen legacy client | React + Vite (no RN) | Nowhere (migration reference only) | **LEGACY** (Low: 14 cross-cutting commits in 60d) |
| `apps/desktop` | Desktop shell wrapper | Tauri + Rust | Native desktop shell (`dist-web-shell`) | **SCAFFOLD** (Low: 1 commit in 60d, active in another lane) |
| `apps/server` | Shared backend | Node.js / Express + Socket.IO + Neo4j | GCP Prod (`chat.globalbr.ai/api/*`) | **CANONICAL** (Moderate: 52 commits in 60d) |
| `apps/mcp-server` | Agent tools bridge | TypeScript (Node) | Claude local / connector | **CANONICAL** (Low: 8 commits in 60d) |
| `infra/` | Production deployment | Docker / bash scripts | GCP Prod (Instance `noos`) | **CANONICAL** |

> **Note:** `apps/mobile` is the singular product client for both native mobile and responsive web. `apps/web` is entirely legacy and retained only for history and migration reference.
