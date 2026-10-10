# openchat-mobile

React Native (Expo) OpenChat app. New builds default to
`https://chat.ideaflow.app` and export the canonical responsive RN-web app
served at `/app`. See the [domain rollout](../../docs/chat-domain-rollout.md)
for the production cutover and old-host compatibility.

## What works today

- Sign in with Noos email/password (Alice / Bob / your account)
- Google sign-in (native iOS and responsive web)
- Conversation list (live-sorted by latest message)
- Self-conversations, consistently labeled **Myself**
- Open a conversation → message thread renders
- Search conversations and messages
- Send messages via Socket.io (REST fallback)
- Receive messages live via WebSocket
- Native push registration and conversation routing; see
  [notification behavior and delivery limits](../../README.md#notifications-and-conversation-links)
- System dark mode (follows system appearance)
- Responsive master-detail layout at desktop/tablet widths
- iPad landscape support (`orientation: 'default'`)
- Web keyboard shortcuts, including Up/Down conversation navigation in the
  wide master-detail layout
- Private conversational capture in My Agent, with explicit activation for
  quiet matching or selected-audience, expiring Stories
- Fulfillment, reciprocal, and shared-goal matching with anonymous proposals
  and double opt-in before a DM is created
- Actionable review queue plus reversible Enhanced / Simple chat modes and an
  independent network pause

## What's stubbed / TODO

- Noos SSO via WebView (currently using direct password POST to `/api/auth/login`)
- Phone OTP (see the [deferral decision](../../docs/decisions/2026-06-01-phone-sign-in.md))
- Group creation flow
- Group settings (rename, add/remove member, leave)
- Presence indicators, typing indicators
- @-mentions, reactions, media
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

### Google sign-in and release reporting

Tap **Continue with Google** to choose a Google account. If the native
sign-in request is still preparing, an alert asks you to retry shortly.
While Google opens, the button shows a spinner; dismissing the sign-in
restores the button. Startup and sign-in errors appear in an alert.

When reporting a sign-in problem, include the small version label at the
bottom right of the login screen. It shows the configured app version and,
on iOS, the installed build number (falling back to the manifest build if
installed metadata is unavailable). A running downloaded update adds the
first eight characters of its update ID; web builds include the configured
build date when available. The label is available before signing in.

### Scan an OpenChat card

From Chats, open **People**, then **Scan a code**.
In a browser, tap **Start camera** to enable the camera; opening the scanner
alone does not request access. Leaving the scanner or opening a recognized
card stops the camera. Repeated frames open the card only once.

The browser scanner accepts only OpenChat card links recognized by
`src/utils/parseOpenChatUrl.ts`, with a valid card token. Other codes, including
group invites and arbitrary destinations, are rejected; native scanning also
supports people and group invites.

If camera access is denied or unavailable, paste the card link into
**Or paste a card link** and tap **Open card**. On a phone, you can also scan
the card using the system Camera app and tap its OpenChat link.

Scanning opens a card for review. **Save contact** downloads a contact file
separately; **Add friend** requests the other person's approval. Neither
scanning nor requesting friendship sends a message.

### Set a private contact name

A conversation is optional: from Chats, open **Friends**, **People**, or **Search**, then choose **Profile** beside a person. This loads their visible official identity by canonical OpenChat ID and exposes the same private-name controls without creating or sending a message.

From **Chats**, open a person's chat and tap their name to open **Contact
Info**. Open **Private to you**, tap **Set private name**, enter a
single-line name of up to 100 characters, then **Save private name**. Use
**Edit private name** to change it, or **Clear private name** inside the editor
to restore their official label.

The private name appears only for your account in Contact Info and direct-chat
headers, on native and responsive web. When set, these surfaces also show
**OpenChat name**, the person's self-set profile name; neither name is proof
of identity. Your alias does not change their profile or names shown in search,
shared cards, or other people's views. You cannot set one for yourself, a bot,
or an imported contact without a linked OpenChat account. If the person becomes
unavailable, saving fails without changing the displayed name.

See the [private-name API and privacy contract](../../docs/private-contact-names.md)
for account isolation and visibility rules.

### Pointing at a different backend

```bash
EXPO_PUBLIC_OPENCHAT_URL=https://chat.ideaflow.app \
EXPO_PUBLIC_NOOS_URL=https://globalbr.ai \
  npx expo start
```

These are the build defaults; the browser app also uses the origin that served
it when opened on either public host.

### Web and desktop exports

The RN-web app is the single production web client:

```bash
cd apps/mobile
npm run export:web:app      # dist-web-app, assets under /app/
```

The layout switches at runtime by width (`src/theme/breakpoints.ts`): at
900px and wider it renders the persistent sidebar + conversation pane; below
that it uses the phone stack. On native, the split view also requires a
tablet-sized short side so landscape phones stay in the mobile layout. The
Tauri desktop wrapper in `../desktop` consumes the separate `dist-web-shell`
export. Reference screenshots for the wide split view and narrow phone layout
live in `docs/screenshots/`.

## Architecture

```
App.tsx                      # screen router (loading → login → conversations → chat)
src/api/
  client.ts                  # REST: auth, chat, drafts, Stories, matches, preferences
  socket.ts                  # Socket.io: connect, join, send, message:new listener
src/components/
  MasterDetailLayout.tsx     # wide iPad / desktop sidebar + chat pane
  StoriesStrip.tsx           # selected-audience Story rail
src/contexts/
  SocialExperienceContext.tsx # enhanced/simple, network, and layout preferences
src/screens/
  LoginScreen.tsx
  HomeScreen.tsx             # responsive home: master-detail or conversations list
  ConversationsScreen.tsx
  ChatScreenRouter.tsx       # redirects desktop-width chat routes into the right pane
  ChatScreen.tsx
  AgentOverlayScreen.tsx     # private My Agent capture and activation
  AsksScreen.tsx             # drafts, searches, Stories, and matches inventory
  SocialReviewScreen.tsx     # bounded actionable review queue
  StoryComposerScreen.tsx
  StoryViewerScreen.tsx
src/theme/breakpoints.ts     # 900px desktop switch + native tablet guard
src/theme/colors.ts          # shared light/dark palette tokens
```

Native and RN-web builds use the same JWT, routes, socket events, and backend
deployment.

## Codex / Claude review notes

This is the bones of the prototype per the success criteria in `OpenChat-dv0`. Before declaring the RN path validated:

- [ ] Warm start <200ms on iPhone 12 / equivalent Android
- [ ] Send-message latency p50 <400ms, p95 <1.5s on LTE
- [ ] Keyboard-open scroll-to-bottom 60fps with 100+ messages
- [ ] Native module integration (Contacts via expo-contacts) works without ejecting from Expo Managed
- [ ] EAS Update OTA functional
- [ ] One platform-only feature works (Android Contacts → "X of your contacts are on OpenChat" UI)

## Password recovery entry

Signed-out Login → **Forgot password?** opens shared native/responsive-web help.
Google-only users should continue with Google or use Google's recovery page.
Apple-only users should continue with Apple in the iPhone app or use Apple's recovery page.
The local email/password fields still use legacy Noos credentials; OpenChat has no verified unauthenticated Noos recovery flow.
The help says this explicitly and never redirects that password to another identity provider.

Ideaflow ID password recovery is unavailable by default. If separately enabled,
the web help displays **Reset Ideaflow ID password** with guidance to use it only
for an Ideaflow ID password account. Users choose their account method; the help
does not look up accounts or infer methods from an email. It does not prefill
addresses, send mail, create accounts or link identities.
Native help does not display the optional Ideaflow ID reset link.
See the [provider recovery configuration and activation gate](../../docs/ideaflow-id-migration.md#password-recovery-capability)
for operator requirements. This entry provides recovery help, not a working
Noos or production Ideaflow ID password-reset flow.
