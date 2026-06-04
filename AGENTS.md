# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## 🔁 Web ↔ Mobile parity (MANDATORY)

This repo is **half of OpenChat** and must stay in sync with the web/server repo:

| Repo | What it is | Surfaces |
|------|-----------|----------|
| `tmad4000/openchat-mobile` (this repo) | React Native / Expo app | native iOS (TestFlight) + RN-web at **`/m`** (mobile web) and **`/d`** (desktop web) |
| `IdeaFlowCo/OpenChat` (`~/code/OpenChat`) | Node/Express + Neo4j **server**, legacy Vite **web** client, and the deploy host that `expo export`s THIS repo into `/m` and `/d` | `chat.globalbr.ai`, `/legacy` |

**Rule: any user-facing chat change you make here, you must also make in `~/code/OpenChat`'s web client** (and vice versa), in the SAME work session, so native and web never drift — composer behavior, send/receive, auth flows, message rendering, presence, etc. The backend is shared (one server), so server changes cover both; **client changes do NOT cross repos automatically.**

- This repo's RN-web build powers `/m` and `/d`. `~/code/OpenChat/deploy.sh` runs `expo export` here and serves the output — so deploying the web app ships whatever is committed in THIS repo. Commit + push here, then run the OpenChat deploy.
- **Platform-appropriate exceptions are fine** (document them): e.g. Enter-to-send is **web-only** (`Platform.OS === 'web'`). On a native touch keyboard the return key stays a newline and sending is the send button. No hardware-keyboard Enter handling needed.
- Standing tracker: epic **openchat-3jq** ("keep web/mobile in sync").
