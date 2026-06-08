# Android — Google Play internal testing track (setup)

Goal: distribute OpenChat Android via Play's **internal testing** track so testers
install from the Play Store with **no "Play Protect blocked / unknown developer"
warning** (the sideloaded-APK problem — see `openchat-tcg`).

Package: `com.jacobcole.openchat` · Expo app · EAS builds an **AAB** on the
`production` profile (what Play wants). EAS config is already wired (`eas.json`:
`submit.production.android` → `track: internal`, `build.production.android.credentialsSource: remote`).

## HUMAN GATES (only Jacob can do — Google requires payment + identity)

1. **Google Play Console developer account** — https://play.google.com/console
   - $25 one-time fee.
   - **Identity verification** (Google requires it now; can take hours–days). This is
     the real bottleneck — start it first.
   - Use the IdeaFlow Google identity if this should be an org account, or a personal
     Google account for a personal listing. (Decide ownership before paying.)
2. **Create the app** in Play Console: name "OpenChat", package `com.jacobcole.openchat`,
   default language, app/not-game, free.
3. **Play App Signing**: accept it (Google holds the app signing key; EAS holds the
   upload key — that pairing is automatic with EAS remote credentials).
4. **Minimal store presence for internal testing**: app icon, short description, and the
   required policy declarations (privacy policy URL → use `https://chat.globalbr.ai/legal/privacy`,
   data safety form, content rating). Internal testing needs less than production, but
   these forms are still gated.
5. **Service account for automated upload** (so `eas submit` works):
   - Play Console → Setup → **API access** → create/link a Google Cloud project →
     create a **service account** → grant it "Release to testing tracks" → download the
     **JSON key**.
   - Save it to **`~/.config/google-play/openchat-play-service-account.json`** (mode 0600)
     — that's the path `eas.json` already points at. Add a note in
     `~/.config/google-play/README.md` per the credential-cache convention.
6. **Add testers**: Play Console → internal testing → testers (email list) OR a
   shareable opt-in link.

## AUTOMATABLE (agent can run once the gates above are cleared)

```bash
cd ~/code/OpenChat/apps/mobile
# 1. Build a signed AAB (EAS manages the upload keystore; first run generates it):
eas build --platform android --profile production --non-interactive
# 2. Submit to the internal track (uses the service-account JSON above):
eas submit --platform android --profile production --latest --non-interactive
```

After the first submit, the internal-track link appears in Play Console; share it with
testers. Subsequent releases are just the two commands again (versionCode auto-increments
via EAS `appVersionSource: remote`).

## Notes

- EAS Android cloud build is ~15–30 min; needs an authenticated `eas` session
  (`eas whoami`). Free tier has a monthly build quota.
- The landing page should also get an Android note: until the Play listing is live,
  sideload testers must tap **"Install anyway"** on the Play Protect warning (`openchat-tcg`).
