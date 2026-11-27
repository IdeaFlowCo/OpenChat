# First sign-in onboarding and native release differences

Investigated 2026-11-27 (openchat-yla). No publication or deployment is part of this change.

## Distribution evidence

The brief identified EAS iOS build 138 (`0fe3e4f`, version/runtime 1.0.20) as the App Store binary. That premise was incorrect: the public US App Store lookup for app 6774991932 returned **1.0.6**, released 2026-10-06. A STORE-distribution EAS build is suitable for App Store Connect upload; it does not prove public App Store release or TestFlight availability.

OTA owner 1a7a9d3b read EAS build/update/channel state through the existing `op run` route. The newest 50 production update groups target runtimes 1.0.20, 1.0.19, 1.0.4, 0.1.26 and 0.1.24; none target 1.0.6. Production maps to the production branch. Exact 1.0.6 binary commit, build number, embedded channel and TestFlight tester availability require App Store Connect or device evidence and remain unknown. Other storefronts were not checked.

React Native shares source code, not release state. Each native binary contains native modules/configuration and an embedded JavaScript bundle. EAS Update selects JavaScript by channel and compatible runtime. This app uses the appVersion runtime policy, so 1.0.20 updates cannot load in 1.0.6. App Store and TestFlight can install different native versions, even from the same repository.

At both `0fe3e4f` and `ae3808e`, updates use ON_LOAD and fallbackToCacheTimeout 0. A launch can run embedded/cached JS while a newer update downloads, then use it after restart. However, the onboarding hook, screen and soft ask are identical at those two commits. That comparison does not explain onboarding appearing only on a second sign-in. Changing native launch-wait configuration in an OTA would not retrofit an installed binary's startup behavior.

## Historical first-sign-in race

The 1.0.6-era source (`405a311`, `8aab892`; exact store commit unverified) renders Main as soon as authentication initializes. Its asynchronous device-onboarding read later adds Onboarding ahead of Main. React Navigation preserves the already-selected Main route instead of switching to the newly available screen. `onboardingRouter.test.ts` reproduces that behavior with the actual StackRouter.

Commit `94358ce` already fixed this by withholding authenticated navigation until the identity-scoped local check settles. Both build-138 source and current OTA source include it. Existing Shell regressions verify first sign-in waits, enters onboarding, and retains compose intent. The code mechanism is confirmed; matching the report to a particular installed store binary still requires its build identity and device reproduction. A native App Store release containing the fixed code is the clear delivery path. A 1.0.6 OTA would first require verifying that binary's channel and native compatibility, and would still not replace its first-launch embedded JS.

## Additional current bug fixed here

Finishing onboarding wrote AsyncStorage and replaced the route, but did not update Shell's in-memory gate. PushSoftAsk stayed disabled for the rest of the session. Compact invite onboarding deliberately skips the notification step, so the card intended to follow it could appear only after another authentication cycle or restart.

Onboarding now notifies the identity-scoped gate after completion and navigation to Main. The gate opens post-onboarding UI immediately without another sign-in; stale callbacks cannot complete a different currently checked identity. The existing completion flag remains per device. Notification consent remains explicit, and the soft-asked flag is not written merely by finishing compact onboarding.

Tests cover normal and compact completion, delayed storage checks, returning devices, sign-out/re-entry, stale identity reads, compose retention, and the historical router race. Linux tests use mocked native surfaces and do **not** verify iOS permission sheets, Apple sign-in, TestFlight, or a physical App Store install.

## Read-only evidence locations

OTA owner's workspace: `/home/dev/code/openchat-stream-design-fix-20261125/onboarding-evidence/`, report `REPORT-native-builds.md`, with `build-list.json`, `update-list-50.json`, `channel-production.json`, `appstore-lookup.txt` and observation time. No credentials are copied into this repository.

SDK 54 documentation: https://github.com/expo/expo/blob/sdk-54/docs/pages/versions/v54.0.0/sdk/updates.mdx (the requested versioned docs site currently redirects to the latest SDK).
