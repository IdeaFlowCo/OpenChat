# Android APK releases

The landing page uses a versioned GitHub release asset, not the temporary
EAS artifact URL. Android releases must be marked `--latest=false` so the
Mac download route continues to resolve to its desktop release.

Build from the reviewed release commit with the existing Expo account:

```sh
cd apps/mobile
eas build --platform android --profile android-apk --non-interactive
```

The `android-apk` profile inherits production settings (including the production
OTA channel and disabled test logins) and uses remote Android signing credentials.
It outputs an APK for direct installation. The app-version runtime policy still
requires OTA updates to match the installed version. Do not assume an old preview
installation receives current production updates.

Download the successful artifact, verify its package is `com.jacobcole.openchat`,
record its version/versionCode, verify its signature with Android `apksigner`,
and compute SHA-256. Upload `OpenChat.apk` and `SHA256SUMS` to the pinned release
used by the landing page. Follow both production hosts' download links and
compare the downloaded bytes and signature with the release artifact.

Vlad Sitalo's November 4 report was `BUILD_NOT_FOUND`: the June preview artifact
expired June 15. The two June 8 production builds failed with
`EAS_BUILD_UNKNOWN_GRADLE_ERROR`; EAS no longer returns their log files, so their
underlying Gradle error cannot be established from the retained build records.
A successful current-source build is required; do not label a guessed cause fixed.

Play internal testing remains a separate configured route; do not claim a Play
release until its actual tester opt-in URL and released version are verified.

## Automated public-download gate

After publishing the GitHub release with `--latest=false`, and before changing
the live landing link, run from the repository root:

```sh
scripts/verify-android-release.sh
# For a subsequent release, pass its tag and expected byte count:
scripts/verify-android-release.sh android-20261115 103835096
```

The script follows HTTPS redirects, checks HEAD/download status and APK content
type, checks the expected size, matches the public `SHA256SUMS`, and tests ZIP
integrity plus the manifest and DEX entries. A draft release fails these checks.
It runs `apksigner verify` if available; otherwise signature verification still
needs the Android build-tools step described above. It neither installs the APK
nor verifies sign-in/runtime behavior. Temporary downloads are removed on exit.
