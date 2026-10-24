#!/bin/bash
# Cut an OpenChat for Mac release in one command.
#
#   apps/desktop/scripts/release.sh            # build + sign + stage in dist/<version>
#   apps/desktop/scripts/release.sh --publish  # ...and publish the GitHub release
#
# Builds the version checked in to src-tauri/tauri.conf.json (bump it, plus
# Cargo.toml and package.json, and commit first). Steps:
#   1. tauri build of OpenChat.app on this host (worktree-local Rust toolchain);
#   2. Developer ID sign + notarize + staple on SIGN_HOST, inside its GUI
#      session (`tmux -L aqua`), producing the updater tarball and the DMG;
#   3. minisign-sign the tarball with the updater key and write latest.json;
#   4. with --publish, create GitHub release desktop-v<version> carrying
#      OpenChat-macOS-arm64.dmg, OpenChat.app.tar.gz and latest.json, then
#      copy latest.json onto the `desktop-feed` prerelease. Installed apps poll
#      releases/download/desktop-feed/latest.json, so the feed only moves once
#      every asset of the new version is uploaded.
#
# Config (env, or ~/.config/openchat-desktop/release.env):
#   SIGN_HOST            ssh alias of the signing Mac (default m5)
#   ASC_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID   App Store Connect API key on SIGN_HOST
#   UPDATER_KEY          minisign private key (default ~/.config/openchat-desktop/updater.key)
#   FEED_BASE            download base written into latest.json (default: the release's
#                        GitHub download URL; override to stage a test feed)
set -euo pipefail

publish=false
[[ ${1:-} == --publish ]] && publish=true

here=$(cd "$(dirname "$0")/.." && pwd)
[[ -f ~/.config/openchat-desktop/release.env ]] && source ~/.config/openchat-desktop/release.env
SIGN_HOST=${SIGN_HOST:-m5}
UPDATER_KEY=${UPDATER_KEY:-$HOME/.config/openchat-desktop/updater.key}
: "${ASC_KEY_PATH:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}"

version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/src-tauri/tauri.conf.json")
grep -q "^version = \"$version\"" "$here/src-tauri/Cargo.toml" || { echo "Cargo.toml version != $version" >&2; exit 1; }
grep -q "\"version\": \"$version\"" "$here/package.json" || { echo "package.json version != $version" >&2; exit 1; }
tag=desktop-v$version
FEED_BASE=${FEED_BASE:-https://github.com/IdeaFlowCo/OpenChat/releases/download/$tag}
out=$here/dist/$version
mkdir -p "$out"
echo "== OpenChat for Mac $version -> $out"

echo "== build"
export RUSTUP_HOME=$here/.toolchain/rustup CARGO_HOME=$here/.toolchain/cargo
export PATH=$CARGO_HOME/bin:$PATH
(cd "$here" && CI=true npx -y @tauri-apps/cli@2.11.2 build --bundles app)
rm -rf "$out/OpenChat.app"
ditto "$here/src-tauri/target/release/bundle/macos/OpenChat.app" "$out/OpenChat.app"

echo "== sign + notarize on $SIGN_HOST"
remote=openchat-desktop-release/$version
ssh "$SIGN_HOST" "rm -rf ~/$remote && mkdir -p ~/$remote"
rsync -a "$out/OpenChat.app" "$here/scripts/sign-notarize.sh" "$SIGN_HOST:$remote/"
ssh "$SIGN_HOST" "export PATH=/opt/homebrew/bin:\$PATH
  tmux -L aqua has-session 2>/dev/null || { echo 'no GUI tmux session (tmux -L aqua) on $SIGN_HOST' >&2; exit 1; }
  tmux -L aqua new-window -d \"cd ~/$remote && ASC_KEY_PATH='$ASC_KEY_PATH' ASC_KEY_ID='$ASC_KEY_ID' ASC_ISSUER_ID='$ASC_ISSUER_ID' bash sign-notarize.sh . > sign.log 2>&1; echo \\\$? > sign.rc\""
# Notarization usually takes a few minutes; give up after 45.
deadline=$((SECONDS + 2700))
until ssh "$SIGN_HOST" "test -f ~/$remote/sign.rc"; do
  if (( SECONDS > deadline )); then
    echo "signing did not finish in 45 min; see $SIGN_HOST:~/$remote/sign.log" >&2
    exit 1
  fi
  sleep 15
done
rc=$(ssh "$SIGN_HOST" "cat ~/$remote/sign.rc")
ssh "$SIGN_HOST" "tail -25 ~/$remote/sign.log"
[[ $rc == 0 ]] || { echo "signing failed (rc=$rc); full log: $SIGN_HOST:~/$remote/sign.log" >&2; exit 1; }
rsync -a "$SIGN_HOST:$remote/OpenChat.app.tar.gz" "$SIGN_HOST:$remote/OpenChat-macOS-arm64.dmg" "$out/"

echo "== updater signature + latest.json"
rm -f "$out/OpenChat.app.tar.gz.sig"
(cd "$here" && npx -y @tauri-apps/cli@2.11.2 signer sign -f "$UPDATER_KEY" -p "" "$out/OpenChat.app.tar.gz" > /dev/null)
python3 - "$out" "$version" "$FEED_BASE" <<'EOF'
import json, sys, datetime
out, version, base = sys.argv[1:]
sig = open(f"{out}/OpenChat.app.tar.gz.sig").read().strip()
manifest = {
    "version": version,
    "notes": f"OpenChat for Mac {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"darwin-aarch64": {"signature": sig, "url": f"{base}/OpenChat.app.tar.gz"}},
}
json.dump(manifest, open(f"{out}/latest.json", "w"), indent=2)
EOF
ls -la "$out"

if $publish; then
  echo "== publish $tag"
  gh release create "$tag" -R IdeaFlowCo/OpenChat \
    "$out/OpenChat-macOS-arm64.dmg" "$out/OpenChat.app.tar.gz" "$out/latest.json" \
    --title "OpenChat for Mac $version" \
    --notes "Installed apps update automatically. First install: download OpenChat-macOS-arm64.dmg."
  gh release view desktop-feed -R IdeaFlowCo/OpenChat > /dev/null 2>&1 ||
    gh release create desktop-feed -R IdeaFlowCo/OpenChat --prerelease --latest=false \
      --title "OpenChat for Mac update feed" \
      --notes "latest.json for installed OpenChat for Mac apps. Downloads: see the newest desktop-v* release."
  gh release upload desktop-feed "$out/latest.json" -R IdeaFlowCo/OpenChat --clobber
fi
