#!/bin/bash
# Developer ID sign, notarize and staple OpenChat.app, then produce the two
# release artifacts next to it:
#   OpenChat.app.tar.gz        auto-update payload (the updater's minisign
#                              signature is added afterwards by release.sh)
#   OpenChat-macOS-arm64.dmg   first-install download linked from the landing page
#
# Runs on the Mac that holds the "Developer ID Application: IdeaFlow, Inc."
# identity. It must run inside the logged-in GUI session (e.g. `tmux -L aqua`),
# where the login keychain is unlocked; plain SSH sessions cannot use the key.
#
# Usage: sign-notarize.sh <dir containing OpenChat.app>
# Env:   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID  (App Store Connect API key)
#        SIGN_IDENTITY (default: Developer ID Application: IdeaFlow, Inc. (JESMXK96LG))
set -euo pipefail

dir=${1:?usage: sign-notarize.sh <dir containing OpenChat.app>}
cd "$dir"
identity=${SIGN_IDENTITY:-"Developer ID Application: IdeaFlow, Inc. (JESMXK96LG)"}
: "${ASC_KEY_PATH:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}"
notary=(xcrun notarytool submit --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait)

echo "== sign app"
codesign --force --deep --options runtime --timestamp --sign "$identity" OpenChat.app
codesign --verify --deep --strict --verbose=2 OpenChat.app

echo "== notarize app"
rm -f OpenChat-notarize.zip
ditto -c -k --keepParent OpenChat.app OpenChat-notarize.zip
"${notary[@]}" OpenChat-notarize.zip | tee notarize-app.log
grep -q "status: Accepted" notarize-app.log
xcrun stapler staple OpenChat.app
spctl --assess --type execute --verbose=2 OpenChat.app
rm -f OpenChat-notarize.zip

echo "== updater payload"
rm -f OpenChat.app.tar.gz
COPYFILE_DISABLE=1 tar -czf OpenChat.app.tar.gz OpenChat.app

echo "== dmg"
rm -rf dmg-root OpenChat-macOS-arm64.dmg
mkdir dmg-root
ditto OpenChat.app dmg-root/OpenChat.app
ln -s /Applications dmg-root/Applications
hdiutil create -volname OpenChat -srcfolder dmg-root -ov -format UDZO OpenChat-macOS-arm64.dmg
rm -rf dmg-root
codesign --force --timestamp --sign "$identity" OpenChat-macOS-arm64.dmg
"${notary[@]}" OpenChat-macOS-arm64.dmg | tee notarize-dmg.log
grep -q "status: Accepted" notarize-dmg.log
xcrun stapler staple OpenChat-macOS-arm64.dmg
spctl --assess --type open --context context:primary-signature --verbose=2 OpenChat-macOS-arm64.dmg

echo "== done"
