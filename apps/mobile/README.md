# openchat-mobile

React Native (Expo) prototype of OpenChat. Connects to the same production backend at `https://chat.globalbr.ai`. Tracks beads ticket `OpenChat-dv0`.

## What works today (v0 scaffold)

- Sign in with Noos email/password (Alice / Bob / your account)
- Conversation list (live-sorted by latest message)
- Open a conversation → message thread renders
- Send messages via Socket.io (REST fallback)
- Receive messages live via WebSocket
- System dark mode (follows iOS appearance setting)

## What's stubbed / TODO

- Noos SSO via WebView (currently using direct password POST to `/api/auth/login`)
- Google sign-in / phone OTP
- Group creation flow
- Group settings (rename, add/remove member, leave)
- Presence indicators, typing indicators
- @-mentions, reactions, media, search
- Push notifications (APNs) — depends on `OpenChat-t81` server work
- Manual theme override (currently follows system only)

## Running

```bash
cd ~/code/openchat-mobile
npm install          # one-time
npx expo start       # starts Metro bundler + QR code
```

Then on your iPhone:
1. Install **Expo Go** from the App Store if you don't have it.
2. Open the Camera app, point it at the QR code in your terminal.
3. The OpenChat-mobile app launches inside Expo Go.

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
App.tsx                      # screen router (loading → login → conversations → chat)
src/api/
  client.ts                  # REST: getConversations, getMessages, sendMessage, login
  socket.ts                  # Socket.io: connect, join, send, message:new listener
src/screens/
  LoginScreen.tsx
  ConversationsScreen.tsx
  ChatScreen.tsx
src/theme/colors.ts          # palette tokens (light + dark, parity with web)
```

The auth + chat protocol is identical to the web client — same JWT, same routes, same socket events. Re-uses the same backend deployment.

## Codex / Claude review notes

This is the bones of the prototype per the success criteria in `OpenChat-dv0`. Before declaring the RN path validated:

- [ ] Warm start <200ms on iPhone 12 / equivalent Android
- [ ] Send-message latency p50 <400ms, p95 <1.5s on LTE
- [ ] Keyboard-open scroll-to-bottom 60fps with 100+ messages
- [ ] Native module integration (Contacts via expo-contacts) works without ejecting from Expo Managed
- [ ] EAS Update OTA functional
- [ ] One platform-only feature works (Android Contacts → "X of your contacts are on OpenChat" UI)

Push notifications (`OpenChat-t81`) are the next big native unlock.
