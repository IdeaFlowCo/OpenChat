# OpenChat Mobile

React Native (Expo) OpenChat client. It ships as native iOS/Android and as the
RN-web builds mounted at `/m` and `/d`, all against the shared production backend
at `https://chat.globalbr.ai`.

## What works today

- Sign in with Noos email/password (Alice / Bob / your account)
- First-run onboarding: welcome, profile, notifications, and an agent-ready step
  that points users to agent keys and the Thoughts tab
- Conversation list (live-sorted by latest message)
- Open a conversation → message thread renders
- Send messages via Socket.io (REST fallback)
- Receive messages live via WebSocket
- Thoughts tab for private notes/memory with tags, search, and live updates
- Settings → Copy agent setup / Agent keys for MCP and REST access
- System dark mode plus in-app theme override

## What's stubbed / TODO

- Noos SSO via WebView (currently using direct password POST to `/api/auth/login`)
- Google sign-in / phone OTP
- Public shareable transcript links
- AI extraction from chats into Thoughts
- Real-time agent listen/subscribe

## Running

```bash
cd apps/mobile
npm install          # one-time
npx expo start       # starts Metro bundler + QR code
```

Then on your iPhone:
1. Install **Expo Go** from the App Store if you don't have it.
2. Open the Camera app, point it at the QR code in your terminal.
3. The OpenChat app launches inside Expo Go.

Sign in with `alice@noos.app` / `password123` (test account) or your real Noos credentials.

### Pointing at a different backend

```bash
EXPO_PUBLIC_OPENCHAT_URL=https://chat.globalbr.ai \
EXPO_PUBLIC_NOOS_URL=https://globalbr.ai \
  npx expo start
```

Defaults are the production URLs above.

## Architecture

```
App.tsx                      # screen router (loading → login → onboarding → tabs)
src/api/
  client.ts                  # REST: auth, chat, thoughts, agent keys, feedback
  socket.ts                  # Socket.io: connect, join, send, message:new listener
src/screens/
  LoginScreen.tsx
  OnboardingScreen.tsx       # first-run profile, notifications, agent-ready tour
  ConversationsScreen.tsx
  ChatScreen.tsx
  ThoughtsScreen.tsx
  SettingsScreen.tsx
  AgentKeysScreen.tsx
src/theme/colors.ts          # palette tokens (light + dark, parity with web)
```

The auth + chat protocol is identical to the web client — same JWT, same routes, same socket events. Re-uses the same backend deployment.

## Release notes

The release and tester workflow lives in [`../../docs/testers.md`](../../docs/testers.md).
Use OTA updates for JS-only copy/UI changes and a native TestFlight build for
Expo config, native module, permission, or version changes.
