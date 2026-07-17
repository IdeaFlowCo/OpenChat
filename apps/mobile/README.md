# openchat-mobile

React Native (Expo) OpenChat app. Connects to the same production backend at
`https://chat.globalbr.ai` and also exports the RN-web builds served at `/m`
and `/d`.

## What works today (v0 scaffold)

- Sign in with Noos email/password (Alice / Bob / your account)
- Conversation list (live-sorted by latest message)
- Open a conversation → message thread renders
- Send messages via Socket.io (REST fallback)
- Receive messages live via WebSocket
- System dark mode (follows system appearance)
- Responsive master-detail layout at desktop/tablet widths
- iPad landscape support (`orientation: 'default'`)
- Web keyboard shortcuts, including Up/Down conversation navigation in the
  wide master-detail layout

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
cd apps/mobile
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

### Web and desktop exports

The RN-web app is the source for both production web mounts:

```bash
cd apps/mobile
npm run export:web:mobile   # dist-web-m, assets under /m/
npm run export:web:desktop  # dist-web-d, assets under /d/
npm run export:web:app      # dist-web-app, root-relative assets for desktop shells
```

The layout switches at runtime by width (`src/theme/breakpoints.ts`): at
900px and wider it renders the persistent sidebar + conversation pane; below
that it uses the phone stack. On native, the split view also requires a
tablet-sized short side so landscape phones stay in the mobile layout. The
Tauri desktop wrapper in `../desktop` consumes `dist-web-app`. Reference
screenshots for the wide split view and narrow phone layout live in
`docs/screenshots/`.

## Architecture

```
App.tsx                      # screen router (loading → login → conversations → chat)
src/api/
  client.ts                  # REST: getConversations, getMessages, sendMessage, login
  socket.ts                  # Socket.io: connect, join, send, message:new listener
src/components/
  MasterDetailLayout.tsx     # wide iPad / desktop sidebar + chat pane
src/screens/
  LoginScreen.tsx
  HomeScreen.tsx             # responsive home: master-detail or conversations list
  ConversationsScreen.tsx
  ChatScreenRouter.tsx       # redirects desktop-width chat routes into the right pane
  ChatScreen.tsx
src/theme/breakpoints.ts     # 900px desktop switch + native tablet guard
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
