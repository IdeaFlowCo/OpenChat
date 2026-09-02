# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

## Responsive layout (iPad / desktop)

The app is width-responsive, not device-typed. `src/theme/breakpoints.ts`
(`useIsDesktop`, 900px plus a 600px native short-side tablet guard) is the
single source of truth: at desktop/tablet widths `HomeScreen.tsx` renders
`MasterDetailLayout.tsx` (persistent sidebar + conversation pane + keyboard
shortcuts / hover / arrow-key nav where the platform supports them); below it,
the same phone stack is used. Web-only `*.web.tsx` files still need native
sibling shims or Metro fails the native build. iPad landscape is enabled via
`orientation: 'default'` in `app.config.js`. The desktop app is a thin Tauri
wrapper around the RNW export — see `apps/desktop/README.md`; product code stays
here in `src/`.

## 🔁 Web ↔ Mobile parity (MANDATORY)

This app lives in the OpenChat monorepo and must stay in sync with the
web/server surfaces:

| Path | What it is | Surfaces |
|------|-----------|----------|
| `apps/mobile` | React Native / Expo app | experimental RN-web previews at **`/m`** and **`/d`** + private native experiments |
| `apps/desktop` | Tauri shell around the `apps/mobile` RN-web app export | native desktop shell |
| `apps/server` / `apps/web` | Node/Express + Neo4j **server** and legacy Vite **web** client | `chat.globalbr.ai/api/*`, `/legacy` compatibility fallback |

The authoritative release status for each client surface is in
[`docs/gcp-production.md`](../../docs/gcp-production.md#client-surfaces-and-release-status).

**Rule: any user-facing chat change in `apps/mobile` or `apps/web` must be
mirrored in the other client in the SAME work session** so native and web never
drift — composer behavior, send/receive, auth flows, message rendering,
presence, etc. The backend is shared (one server), so server changes cover both;
client changes do not cross surfaces automatically.

- The `apps/mobile` RN-web build powers `/m` and `/d`. `infra/deploy.sh` runs
  the export and serves the output, so deploying the web app ships whatever is
  committed in this monorepo.
- **Platform-appropriate exceptions are fine** (document them): e.g. Enter-to-send is **web-only** (`Platform.OS === 'web'`). On a native touch keyboard the return key stays a newline and sending is the send button. No hardware-keyboard Enter handling needed.
- Standing tracker: epic **openchat-3jq** ("keep web/mobile in sync").
