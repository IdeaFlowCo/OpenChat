# Client version and Updated stamp

The Settings footer and signed-out `/app/` footer use `AppStamp`. The native
version remains the existing `app.config.js` version (currently 1.0.20); this
change does not require a native build, change runtime compatibility, or bump a
version. Native sign-in retains the installed build number and OTA update ID.

`extra.appStamp` records version, full commit, committer time and build time.
Clean sources use the committer time; dirty trees and source archives without
git use the recorded build time, explicitly marked in exact details. Missing or
invalid timestamps show the version alone. No time is inferred from file mtime,
page visits or HTTP headers.

`infra/build-web.sh` freezes one record before the Expo export through
`OPENCHAT_STAMP_FILE`. It writes that same record into `client-app/dist/version.json`
and the Expo configuration consumed by the bundle. `/app/version.json` serves
the export; `/version.json` serves the same file through the server. Both are
public and contain only source/build identity. A deployment must include the
server route as well as the client export; an old-server frontend-only layer
cannot add the root metadata endpoint. Preserve the common production lock,
review and exact-source release gates. This document authorizes no release.

The clock runs once a minute while visible/active and refreshes on return.
The web stamp uses a semantic `time` element with a zoned exact title and commit.
Its button supports tap, Enter and Space and retains native browser focus.
Exact details toggle back to relative time; no live region announces aging.
The normal label is small, muted, tabular text in the footer, outside the chat
canvas. Native uses the same formatter and an accessible touch control.

The existing `openchat-feedback` WIT integration is unchanged: menu/Settings
opens the lazy loader with `data-trigger="none"`; identity token retrieval is
queued until requested. Verification must not submit a real report or alter
authentication/privacy to inspect the panel.

The separate marketing `/` page still exists as of the 14dd reconciliation.
This patch covers the canonical client signed-out surface and Settings; marketing
landing stamp/theme/feedback belongs to its existing owner and is not silently
claimed as fixed.

Validation: run `npx vitest run test/appStamp.mobile.test.ts` from `apps/server`,
mobile TypeScript/lint, and `bash infra/build-web.sh`. Check the exported metadata
against the clean source SHA, then verify signed-out and Settings stamps at
390px and desktop, exact-toggle keyboard/tap behavior and both public metadata
routes in the intended release. Linux browser tests do not verify physical
native devices or VoiceOver.
