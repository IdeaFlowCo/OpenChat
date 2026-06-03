#!/bin/bash
# local-build.sh — build the iOS app on this Mac instead of EAS cloud.
# No queue wait + no EAS credits used.
#
# Prereqs (all present on M3, verified 2026-06-02):
#   - Xcode 26+ (xcode-select -p == /Applications/Xcode.app/Contents/Developer)
#   - CocoaPods 1.16+
#   - Node 18+
#   - fastlane (brew install fastlane)
#
# Usage:
#   bash scripts/local-build.sh           # bump patch + build + auto-submit
#   bash scripts/local-build.sh --no-bump # skip version bump (rebuild same version)
#   bash scripts/local-build.sh --message "Build 46: foo"
#
# After completion:
#   - .ipa is at $PWD/build-*.ipa
#   - auto-submitted to TestFlight via EAS Submit (uses the ASC API key)
#   - The build still appears in Expo's dashboard so 'eas build:list' shows it

set -e

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

# ── Version bump (so each build has a unique number) ─────────────────────────
if [ "$BUMP" = "1" ]; then
  echo "── bumping patch version ──"
  npm run bump:patch
  NEW_VERSION=$(grep -oE "version: '[^']+'" app.config.js | head -1 | sed "s/version: '//" | sed "s/'//")
  echo "  → $NEW_VERSION"
  git add app.config.js
  git commit -m "chore(version): bump for local build at $(date +%H:%M)"
  git push 2>&1 | tail -2
fi

# ── ASC + Apple env vars (also used by EAS Submit step) ──────────────────────
export EXPO_ASC_API_KEY_PATH=/Users/jacobcole/.appstoreconnect/private_keys/AuthKey_KWJX4896S5.p8
export EXPO_ASC_KEY_ID=KWJX4896S5
export EXPO_ASC_ISSUER_ID=69a6de95-2833-47e3-e053-5b8c7c11a4d1
export EXPO_APPLE_TEAM_ID=JESMXK96LG
export EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION

DEFAULT_MSG="Local build $(date +%Y-%m-%d) — built on $(hostname -s)"
MSG="${MESSAGE:-$DEFAULT_MSG}"

echo ""
echo "════ STARTING LOCAL EAS BUILD ════"
echo "  Profile:  production"
echo "  Platform: ios"
echo "  Message:  $MSG"
echo "  This runs on this Mac (not EAS cloud) — no queue, no credits."
echo ""

# ── Build (and auto-submit to TestFlight) ────────────────────────────────────
# --local: build on this machine
# --auto-submit: pipe the resulting .ipa to EAS Submit → App Store Connect
# --non-interactive: don't prompt for anything (env vars cover it)
IPA_OUT="./build-$(date +%Y%m%d-%H%M%S).ipa"

# Step 1: build locally. EAS rejects --auto-submit when --local is set,
# so we split into separate build + submit calls.
eas build \
  --platform ios \
  --profile production \
  --local \
  --non-interactive \
  --output "$IPA_OUT" \
  --message "$MSG"

# Step 2: submit the resulting .ipa to App Store Connect.
echo ""
echo "──── submitting $IPA_OUT to App Store Connect ────"
eas submit \
  --platform ios \
  --path "$IPA_OUT" \
  --non-interactive

# ── Push the build to external testers ───────────────────────────────────────
# eas auto-submits to App Store Connect, which makes the build VALID for
# internal Founders testers within ~1 minute. External testers (Friends and
# Family — Sandeep, Whimsi, Kristen, etc.) require:
#   1. explicit assignment to the Friends and Family beta group
#   2. Apple Beta App Review approval (24-48h typical)
# Without this they'd never see the build. publish-to-testers.py polls until
# ASC has the new build, then drives both steps via the ASC API. Safe to
# run repeatedly; it noops on already-assigned / already-submitted builds.
echo ""
echo "──── publishing to external testers (Friends and Family) ────"
chmod +x "$(dirname "$0")/publish-to-testers.py"
python3 "$(dirname "$0")/publish-to-testers.py"

echo ""
echo "════ DONE ════"
echo "Built locally on $(hostname). On TestFlight for internal + external testers."
echo "Check status:  eas submit:list --platform ios --limit 1"
