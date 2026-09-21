# Group-open crash audit (2026-09-21)

This change fixes demonstrated client defects and reduces native work when a
thread opens. **It does not establish the root cause of Olivia's native crash.**
An exact device crash report and validation on the affected iOS build remain
necessary. Native crash capture is a separate follow-up; no Sentry is added.

## Evidence and scope

- Live two-account reproduction: Alice created “Sailing Buddies” with Bob and
  Charlie (the API requires three initial members). Bob left, Alice added him,
  and Bob opened the group using the responsive mobile client. Opening and
  receiving a message succeeded. Removing Bob and accepting an owner invite
  also succeeded. The test invite was revoked and all test memberships removed.
- A read-only production audit of the reported group found six populated user
  nodes, including the newly joined member. Both messages were plain text with
  valid sender nodes. List, detail, create, add-member and invite projections
  include `user`; `loadConversation` excludes absent matches. No server
  projection gap was demonstrated, so server behavior is unchanged.
- Available production client logs contained no error stack. Firstmate supplied
  separate TestFlight reports showing a Hermes SIGSEGV (with a microphone/edit
  comment) and an older ObjC TurboModule exception. None identifies Olivia's
  incident or the native module responsible. Native faults can bypass the JS
  logger; these reports do not prove a particular JS call caused this crash.

## Mount-path audit

| Path | Finding and action |
| --- | --- |
| Native-stack header | `showMuteMenu` was recreated each render and included in the `setOptions` layout effect. Recorder updates every 100ms and composer edits therefore recreated header callbacks and options. Memoize the menu callback; depend on the displayed direct-chat status instead of the entire presence map. |
| Receive haptics | Message-count growth treated initial REST history and older-page prepends as incoming messages, invoking Expo haptics while opening a thread. Track the newest message identity and loading/conversation transitions; only an appended live incoming message triggers feedback. This removes unnecessary calls, without claiming Expo haptics itself is broken. |
| Shared message buffer / media | ChatScreen could render the previous conversation's messages before its mount effect started loading the selected thread. Filter by conversation ID before rows, media and effects consume messages. |
| History load races | An older request's `finally` could clear the selected group's loading flag, allowing its eventual history to look like a live append. A load generation now owns both the result and loading state, even when reopening the same group. |
| Notification selection | `setActiveConversationForNotifications` only assigns a JS variable. It makes no native call. The separate badge-count effect is in ChatContext. |
| Recording and playback | `useRecording` reads an app-wide provider. Recording initialization requires a mic gesture; playback requires a play gesture. Opening a text-only group starts neither. The recorder ticker does explain frequent header updates while recording. |
| Avatars / attachments | Group headers and message avatars use initials. Attachments can decode images when rendered, but the reported group's two messages had no attachments. Filtering stale messages prevents another thread's media mounting here. |
| Keyboard / scrolling | Keyboard listeners, native stack layout, FlatList and KeyboardAvoidingView participate in mounting. No specific native exception was established. Keyboard avoidance behavior is outside this change. There is no gesture-handler or reanimated dependency in the mobile package. |
| Participant / sender rendering | Missing `participant` or `participant.user` caused a JS TypeError in ChatScreen, confirmed with a render regression. Guards cover the group title, empty state, mentions, bot badge, typing lookup, conversation lists and profile updates. Missing sender data uses “OpenChat member” and an initials avatar. `colorForUserId` already accepts absent IDs. The old `filter(Boolean)` protected `u!.name`, but not the earlier `p.user.id` lookup. |

## Regression contract

`apps/server/test/groupOpen.mobile.test.ts` renders the real mobile ChatScreen,
Avatar, ChatEmptyState and MentionAutocomplete using React's matching 19.1.0
test renderer and mocked native boundaries. Before the fix it demonstrated
redundant header updates, history-triggered haptics, stale media, and a null-user
TypeError. It now checks these behaviors, live-message feedback, group switches,
unknown typing users, and missing sender/reply IDs.
`chatLoading.mobile.test.ts` exercises the real ChatProvider with deferred
requests to verify that old loads cannot finish or overwrite the current load.

Run `npm run test --workspace=apps/server` and
`npx tsc --noEmit -p apps/mobile/tsconfig.json` from the root. These checks and
Expo exports validate JS behavior and bundling; they do not execute UIKit,
TurboModules or Hermes on a device and cannot certify that the native incident
has been eliminated.
