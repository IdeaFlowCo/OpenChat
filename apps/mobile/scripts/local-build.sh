#!/bin/bash
# local-build.sh — build the iOS app on this Mac instead of EAS cloud.
# Works over plain SSH or NoMachine. No queue wait, no EAS credits used.
#
# IMPORTANT: do NOT wrap this in tmux. The tmux daemon runs in a stale
# macOS audit/security session that breaks keychain identity resolution
# during codesign. Use plain SSH, or `nohup bash scripts/local-build.sh &`
# if you want it backgrounded.
#
# Prereqs (verified 2026-06-03):
#   - Xcode 26+ (xcode-select -p == /Applications/Xcode.app/Contents/Developer)
#   - CocoaPods 1.16+
#   - Node 18+
#   - Apple Distribution cert in login keychain with codesign ACL granted
#     (security set-key-partition-list -S apple-tool:,apple:,codesign:)
#   - Provisioning profile installed at
#     ~/Library/MobileDevice/Provisioning Profiles/<UUID>.mobileprovision
#   - .credentials/Distribution.p12 + .credentials/Distribution.mobileprovision
#     in the repo root (gitignored)
#   - credentials.json in repo root with credentialsSource: local config
#   - ~/.config/m3-login.txt with the login keychain password (mode 600)
#
# Usage:
#   bash scripts/local-build.sh           # bump patch + build + submit
#   bash scripts/local-build.sh --no-bump # rebuild same version
#   bash scripts/local-build.sh --message "Build 50: foo"
#
# After completion:
#   - .xcarchive is at ~/Library/Developer/Xcode/Archives/<date>/
#   - .ipa is at ./build-<timestamp>.ipa
#   - Auto-submitted to App Store Connect via the ASC API key
#   - publish-to-testers.py assigns to Friends and Family + triggers Apple
#     Beta App Review

set -o pipefail

cd "$(dirname "$0")/.."

if [ ! -f app.config.js ]; then
  echo "ERROR: app.config.js not found. Run from openchat-mobile repo root."
  exit 1
fi

# ── Parse args ────────────────────────────────────────────────────────────────
BUMP=1
MESSAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-bump) BUMP=0; shift;;
    --message) MESSAGE="$2"; shift 2;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done

# ── Refuse to run under tmux ─────────────────────────────────────────────────
if [ -n "$TMUX" ]; then
  echo "ERROR: this script must NOT be run inside a tmux session."
  echo "       tmux's daemon retains a stale audit session that breaks"
  echo "       codesign + keychain identity resolution."
  echo "       Use plain SSH, or 'nohup bash scripts/local-build.sh &'."
  exit 1
fi

# ── Toolchain env guards (make headless / agent / nohup builds work) ─────────
# 1) TMPDIR must NOT live under /tmp. EAS local build stages under $TMPDIR and
#    hands Metro an ABSOLUTE --entry-file. macOS symlinks /tmp -> /private/tmp,
#    so if $TMPDIR is /tmp/... Metro's realpath'd projectRoot (/private/tmp/...)
#    disagrees with the /tmp-form entry path and bundling dies with:
#      "Unable to resolve module /tmp/.../index.ts from /private/tmp/.../."
#    Interactive shells use /var/folders/.../T (canonical) so they never hit it;
#    agent shells often set TMPDIR=/tmp/... and do. Force a canonical $HOME dir.
case "$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" in
  /tmp|/tmp/*|/private/tmp|/private/tmp/*)
    export TMPDIR="$HOME/.ocbuild-tmp"
    mkdir -p "$TMPDIR"
    echo "── TMPDIR repinned to $TMPDIR (avoids /tmp<->/private/tmp Metro bug) ──"
    ;;
esac

# 2) Node must be an Expo-SDK-54-supported LTS (20/22/24). Homebrew's unversioned
#    `node` keg auto-bumps to the latest (e.g. 25), which Metro rejects (same
#    "Unable to resolve module index.ts" symptom) — and a bad keg link can even
#    crash the `eas` CLI (Abort trap: 6 on libsimdjson). If the active node major
#    is unsupported, prefer an installed LTS keg on PATH.
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
case "$NODE_MAJOR" in
  20|22|24) : ;;  # supported
  *)
    for v in 22 20 24; do
      if [ -x "/opt/homebrew/opt/node@$v/bin/node" ]; then
        export PATH="/opt/homebrew/opt/node@$v/bin:$PATH"
        echo "── Node v$NODE_MAJOR unsupported by Expo SDK 54; using node@$v on PATH ──"
        echo "   NOTE: if the in-Xcode bundle phase still fails, make node@$v the"
        echo "   default keg too:  brew unlink node; brew link --overwrite node@$v"
        break
      fi
    done
    ;;
esac

# ── Pre-unlock login keychain so codesign can access the signing key ─────────
LOGIN_PW_FILE="$HOME/.config/m3-login.txt"
if [ ! -f "$LOGIN_PW_FILE" ]; then
  echo "ERROR: $LOGIN_PW_FILE not found."
  echo "       Create it (mode 600) with the M3 login keychain password:"
  echo "         echo 'YOUR_PASSWORD' > $LOGIN_PW_FILE && chmod 600 $LOGIN_PW_FILE"
  exit 1
fi
LOGIN_PW=$(cat "$LOGIN_PW_FILE")
security unlock-keychain -p "$LOGIN_PW" "$HOME/Library/Keychains/login.keychain-db" || {
  echo "ERROR: failed to unlock login keychain — check $LOGIN_PW_FILE"
  exit 1
}
# Keep it unlocked during the build by extending the lock timeout
security set-keychain-settings -lut 21600 "$HOME/Library/Keychains/login.keychain-db"

# Background loop that re-unlocks periodically (in case Apple's tooling
# re-locks it). Kill on exit.
(
  while true; do
    sleep 60
    security unlock-keychain -p "$LOGIN_PW" "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null
  done
) &
UNLOCK_PID=$!
trap "kill $UNLOCK_PID 2>/dev/null" EXIT

# ── Version bump ─────────────────────────────────────────────────────────────
if [ "$BUMP" = "1" ]; then
  echo "── bumping patch version ──"
  npm run bump:patch
  NEW_VERSION=$(grep -oE "version: '[^']+'" app.config.js | head -1 | sed "s/version: '//" | sed "s/'//")
  echo "  → $NEW_VERSION"
  git add app.config.js
  git commit -m "chore(version): bump for local build at $(date +%H:%M)"
  git push 2>&1 | tail -2
fi

# ── ASC + Apple env vars (used by eas build and eas submit) ──────────────────
export EXPO_ASC_API_KEY_PATH=/Users/jacobcole/.appstoreconnect/private_keys/AuthKey_KWJX4896S5.p8
export EXPO_ASC_KEY_ID=KWJX4896S5
export EXPO_ASC_ISSUER_ID=69a6de95-2833-47e3-e053-5b8c7c11a4d1
export EXPO_APPLE_TEAM_ID=JESMXK96LG
export EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION

DEFAULT_MSG="Local build $(date +%Y-%m-%d) — built on $(hostname -s)"
MSG="${MESSAGE:-$DEFAULT_MSG}"

# Record the archive timestamp BEFORE running eas build so we can find
# the new archive after the build (regardless of exportArchive failing).
PRE_BUILD_TS=$(date +%s)

echo ""
echo "════ STARTING LOCAL EAS BUILD ════"
echo "  Profile:  production"
echo "  Platform: ios"
echo "  Message:  $MSG"
echo ""

# ── Build via eas build --local ──────────────────────────────────────────────
# The build goes through compile/link/codesign/archive successfully on
# Tahoe 26.2 over SSH. The final 'xcodebuild -exportArchive' step then fails
# because macOS Tahoe's new openrsync rewrite doesn't accept the -E
# (--extended-attributes) flag that Xcode's IDEDistributionCreateIPAStep
# constructs. We tolerate that failure with `|| true` and do the IPA
# packaging manually below.
THROWAWAY_IPA="./build-throwaway-$(date +%Y%m%d-%H%M%S).ipa"
eas build \
  --platform ios \
  --profile production \
  --local \
  --non-interactive \
  --output "$THROWAWAY_IPA" \
  --message "$MSG" || true

# ── Find the .xcarchive the build just produced ──────────────────────────────
ARCHIVES_DIR="$HOME/Library/Developer/Xcode/Archives"
LATEST_ARCHIVE=$(find "$ARCHIVES_DIR" -name "*.xcarchive" -newer /tmp/.eas-pre-build-marker 2>/dev/null | tail -1)
if [ -z "$LATEST_ARCHIVE" ]; then
  # Fallback: pick the newest archive from today's folder
  TODAY=$(date +%Y-%m-%d)
  LATEST_ARCHIVE=$(ls -td "$ARCHIVES_DIR/$TODAY"/*.xcarchive 2>/dev/null | head -1)
fi
if [ -z "$LATEST_ARCHIVE" ] || [ ! -d "$LATEST_ARCHIVE" ]; then
  echo "ERROR: could not find a .xcarchive produced by this build."
  echo "       Check eas build output above for the actual failure."
  exit 1
fi
echo ""
echo "── archive: $LATEST_ARCHIVE"

APP="$LATEST_ARCHIVE/Products/Applications/OpenChat.app"
if [ ! -d "$APP" ]; then
  echo "ERROR: $APP not found inside archive."
  exit 1
fi

# Verify the .app is signed with the right cert
SIGN_AUTH=$(codesign -dvv "$APP" 2>&1 | grep "^Authority=" | head -1)
echo "── signed by: $SIGN_AUTH"

# ── Manually package into .ipa (replaces xcodebuild -exportArchive) ──────────
IPA_OUT="./build-$(date +%Y%m%d-%H%M%S).ipa"
echo ""
echo "── packaging $APP → $IPA_OUT (manual zip; bypasses broken Tahoe rsync)"
STAGE=$(mktemp -d -t eas-build-stage)
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
(cd "$STAGE" && zip -qry "$IPA_OUT" Payload)
mv "$STAGE/$IPA_OUT" "$(pwd)/$IPA_OUT"
/bin/rm -rf "$STAGE"
ls -la "$IPA_OUT"

# Clean up the throwaway file that eas build was told to create but couldn't
/bin/rm -f "$THROWAWAY_IPA"

# ── Submit to App Store Connect ──────────────────────────────────────────────
echo ""
echo "── submitting $IPA_OUT to App Store Connect ──"
eas submit \
  --platform ios \
  --path "$IPA_OUT" \
  --non-interactive

# ── Push the build to external testers (Friends and Family) ─────────────────
# eas submit makes the build VALID for internal Founders within ~1 minute.
# External testers (Sandeep, Whimsi, Kristen, etc.) require:
#   1. explicit assignment to the Friends and Family beta group
#   2. Apple Beta App Review approval (24-48h typical)
echo ""
echo "── publishing to external testers (Friends and Family) ──"
chmod +x "$(dirname "$0")/publish-to-testers.py"
python3 "$(dirname "$0")/publish-to-testers.py"

echo ""
echo "════ DONE ════"
echo "Built locally on $(hostname). On TestFlight for internal + external testers."
echo "Check status:  eas submit:list --platform ios --limit 1"
