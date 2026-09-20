# OpenChat — Tester Guide & Release Operator Notes

How testers get OpenChat builds, what updates automatically (and what does
not), and how to send feedback. Covers iOS (TestFlight), over-the-air (OTA)
EAS Updates, and the responsive web app at `/app`.

Tracking epic: **openchat-3jq** (release/update pipeline + web↔mobile parity).
Ticket: **openchat-3jq.6**.

---

## 1. How testers get builds

### iOS (TestFlight)

OpenChat ships to iOS via Apple TestFlight. There are two tester tiers:

| Tier | Who | How they're added | Wait for a new build |
|------|-----|-------------------|----------------------|
| **Internal** (Founders) | App Store Connect team members | Added in ASC → Users | Available ~1 min after `eas submit` finishes processing. **No Apple review.** Max 100 internal testers. |
| **External** (Friends & Family) | Anyone with an email invite | Assigned to the *Friends and Family* beta group (group id in `publish-to-testers.py`) | Requires **Apple Beta App Review** (typically 24–48h, human-gated) the first time a build is submitted to external testers. Up to 10,000 external testers. |

**Join link (external):** https://testflight.apple.com/join/QvUPzDMY
(also linked from the invite/landing page the server renders).

A tester installs the **TestFlight** app from the App Store, opens the join
link (or accepts the email invite), and installs OpenChat from inside
TestFlight.

### Web — no install required

| Path | Audience | Notes |
|------|----------|-------|
| `https://chat.globalbr.ai/app` | Phone, tablet, and desktop web | The canonical responsive React-Native-web app. It uses compact navigation on narrow screens and master-detail layout on wide screens. Installable as a PWA. |

Old `/m`, `/d`, and `/legacy` links redirect to `/app` and preserve their
remaining path and query. See [`collapse-m-d.md`](./collapse-m-d.md).

---

## 2. What updates automatically vs. what needs a new build

OpenChat's iOS app has **two** update channels. Understanding which one applies
to a given change determines whether testers get it instantly or have to wait
for a new TestFlight build + (for external testers) Apple review.

### A. OTA — EAS Update (instant, JS/asset-only)

Configured in `apps/mobile/app.config.js`:

```js
updates: {
  url: 'https://u.expo.dev/fc828863-4fa4-4b62-97f6-8c00ce1dffe3',
  enabled: true,
  checkAutomatically: 'ON_LOAD',   // app pulls a fresh bundle on launch
  fallbackToCacheTimeout: 0,
},
runtimeVersion: { policy: 'appVersion' },
```

- **OTA-SAFE changes** (ship instantly, no TestFlight, no Apple review):
  JavaScript/TypeScript logic, React component changes, styling, copy, images
  and other bundled assets, most bug fixes. Push them with
  `eas update --branch production` (channel `production` per `eas.json`).
- The app checks for a new bundle **on launch** (`ON_LOAD`) and applies the
  matching one. Testers just relaunch the app to get the latest JS.
- **`runtimeVersion: appVersion`** is a safety gate: an OTA bundle only reaches
  installs whose native app **version matches** the bundle's runtime version.
  This guarantees we never push JS that's incompatible with the installed
  native runtime. Bumping the app version (new native build) starts a fresh
  runtime version, so OTA updates do not leak across native versions.

### B. Native build — TestFlight (slow, needs a new binary)

A change requires a **new native build** (not OTA) when it touches the compiled
app, including:

- Adding/removing/upgrading a native module or Expo config plugin
  (e.g. anything in the `plugins` array in `app.config.js`).
- Changing native permissions / Info.plist entries (`infoPlist`, camera/photo/
  mic usage strings, `UIBackgroundModes`, URL schemes, entitlements).
- Bumping the Expo SDK or `react-native` version.
- Any change that bumps the marketing `version` (which by `appVersion` policy
  starts a new OTA runtime version — OTA can't reach it until a native build
  with that version is installed).

For these, run the release pipeline (section 4). Internal testers get it
~1 min after processing; external testers wait on Apple Beta App Review.

### Quick decision table

| Change | OTA-safe? | How testers receive it |
|--------|-----------|------------------------|
| Fix a JS bug / tweak UI / change copy | ✅ Yes | `eas update` → relaunch app |
| Add a screen built from existing components | ✅ Yes | `eas update` → relaunch app |
| Add a native module / Expo plugin | ❌ No | New TestFlight build |
| Change a permission string / Info.plist | ❌ No | New TestFlight build |
| Upgrade Expo SDK / react-native | ❌ No | New TestFlight build |
| Web-only (`/app`) change | n/a | `infra/deploy.sh` redeploys; no app store involved |

---

## 3. Tester instructions — enabling automatic updates

**Tell testers to turn ON automatic updates in TestFlight** so they don't sit
on a stale binary:

1. Open the **TestFlight** app.
2. Tap **OpenChat**.
3. Enable **Automatic Updates** (top of the app's TestFlight page).

With this on, TestFlight installs new **native** builds automatically once
they're available to that tester. OTA EAS Updates apply independently on app
launch and don't depend on this setting.

**Note:** even with automatic updates on, external testers only receive a new
native build *after* Apple Beta App Review approves it. There is nothing the
tester or operator can do to skip that review for external groups.

---

## 4. Release operator checklist

Two supported paths. The **local** path is the day-to-day one; the **CI** path
is the portable fallback.

### Local build (primary — runs on the M3)

```bash
cd ~/code/OpenChat/apps/mobile        # or the active worktree
bash scripts/local-build.sh           # bump patch + build + submit + publish
```

`local-build.sh` does the full pipeline:
1. Bumps the patch version in `app.config.js`, commits, pushes.
2. `eas build --local` (compiles + signs + archives on this Mac).
3. Manually repackages the `.ipa` (works around a broken Tahoe rsync).
4. `eas submit` → uploads to App Store Connect.
5. `publish-to-testers.py` → assigns the build to **Friends and Family** and
   triggers **Apple Beta App Review**.

Prereqs are documented in the header of `scripts/local-build.sh` (Xcode 26+,
CocoaPods, Apple Distribution cert in the login keychain, local credentials,
`~/.config/m3-login.txt`). **Do not run it inside tmux** — the script refuses,
because tmux's stale audit session breaks codesign keychain resolution.

### CI build (fallback — GitHub Actions)

`.github/workflows/testflight.yml` runs an **EAS cloud build + submit**
(`workflow_dispatch` or push a `v*` tag). It does *not* reproduce the local
keychain/credentials dance — Expo's build farm holds the credentials. It runs
lint + typecheck + build smoke checks first, then `eas build` then `eas submit`.

Required secrets and first-run setup are documented at the top of that workflow
file. It intentionally does **not** run `publish-to-testers.py` (external-tester
assignment + Beta App Review), so for an external-tester release, prefer the
local path or run `publish-to-testers.py` manually afterward.

### OTA update (JS-only, no store)

```bash
cd apps/mobile
eas update --branch production --message "what changed"
```

Reaches all installs whose native version matches (see runtime version gate).

### Operator checklist (per release)

- [ ] Decide: OTA-safe change (→ `eas update`) or native change (→ build)?
- [ ] If native: version bump intended? (local-build.sh bumps patch; build
      number auto-increments via `eas.json` `autoIncrement`).
- [ ] Run the appropriate path above.
- [ ] Confirm processing in App Store Connect / EAS dashboard.
- [ ] Internal testers: verify the build appears (~1 min).
- [ ] External testers: confirm Beta App Review submitted (it queues if a prior
      build is still in review — see `publish-to-testers.py` 422 handling).
- [ ] Web release: if the change should reach browsers, redeploy the canonical
      `/app` export via `infra/deploy.sh`.

---

## 5. How testers give feedback

Feedback from inside OpenChat creates a **WorldIssueTracker** issue
(`worldissuetracker.com`) labeled `openchat-feedback`, so the team sees it in
one place.

Two in-app entry points (both hit the same backend, same `WIT_AGENT_KEY`):

1. **Settings → "Send feedback"** — type what's working/broken/missing; on
   submit the app confirms with a link to the created issue.
   (`SettingsScreen.tsx` → `api.submitFeedback` → `POST /api/feedback`.)
2. **Assistant → "file feedback"** — just tell the in-app Assistant you want to
   file feedback and it creates the issue for you (rate-limited to 5/hour/user).
   (`apps/server/src/services/assistant.ts`, openchat-1ny.)

Both create an issue via `POST /api/feedback` (`apps/server/src/routes/feedback.ts`),
which calls the WIT `create-issue` function with the server's `X-Agent-Key`.
The created issue's URL is returned to the client so the tester can follow up.

**Server config:** feedback requires `WIT_AGENT_KEY` in the server env. If it's
missing the API returns `503` and the app shows a "feedback not configured"
message — operators should ensure that secret is set in the prod `.env`.

Testers can also use TestFlight's built-in **screenshot → Share Beta Feedback**
flow, which lands in App Store Connect; the in-app paths above are preferred
because they route into the team's issue tracker automatically.
