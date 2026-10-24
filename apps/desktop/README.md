# OpenChat Desktop

A native Tauri window targeting the OpenChat client at
`https://chat.ideaflow.app/app/` — the same react-native-web build of
`apps/mobile` that browsers get. There is no desktop UI codebase and no bundled
copy of the client.

The new host requires the [domain rollout](../../docs/chat-domain-rollout.md)
before this build can connect. Existing desktop installs on the old host keep
working there.

## Why it loads the live URL instead of bundling the export

Loading `/app/` from its real origin is what makes desktop share state with
mobile and web:

- **Same origin, same auth.** A bundled build runs from `tauri://localhost`,
  which is not in the server's CORS allowlist (`apps/server/src/index.ts`) and
  breaks the redirect sign-in flows, whose callback URIs are derived from
  `window.location.origin`. After the new host and OAuth callbacks are
  registered, sign-in returns to the same host that opened the desktop app.
- **Same socket, same data.** The client connects to the same Socket.io server,
  so messages sync live across desktop, web, and the iOS app.
- **Always current.** Every `/app` deploy updates the desktop app too; no
  desktop rebuild is needed for client changes.

The trade-off is that desktop needs network access to start, which a chat client
needs anyway.

`src-tauri/src/main.rs` builds the window and hands `window.open` targets
(`Linking.openURL` on RN-web — for example the Settings links to the landing
page) to the system browser, since the webview has no tabs.

## Build (macOS arm64)

Rust is not installed on the build hosts by default. A worktree-local toolchain
keeps it self-contained (`.toolchain/` is gitignored):

```bash
cd apps/desktop
export RUSTUP_HOME=$PWD/.toolchain/rustup CARGO_HOME=$PWD/.toolchain/cargo
export PATH=$CARGO_HOME/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal   # once

CI=true npx -y @tauri-apps/cli@2.11.2 build
# -> src-tauri/target/release/bundle/macos/OpenChat.app
# -> src-tauri/target/release/bundle/dmg/OpenChat_<version>_aarch64.dmg
```

`CI=true` makes the DMG step skip its Finder AppleScript styling pass, which
times out on a headless host. The DMG still has the Applications drop link.

`tauri build` produces an unsigned bundle. Releases are Developer ID signed and
notarized by `scripts/release.sh` (below), so first launch needs no Gatekeeper
override.

The icons in `src-tauri/icons/` are generated from `apps/mobile/assets/icon.png`
(`npx @tauri-apps/cli@2.11.2 icon ../mobile/assets/icon.png -o src-tauri/icons`).

The root `npm run build` deliberately skips `openchat-desktop`; build it
explicitly from here.

## Versions and auto-update

The chat UI is the live `/app` client, so it updates with every web deploy. The
native shell updates itself (`src-tauri/src/updates.rs`):

- Checks on launch and every 4 hours; downloads in the background; installs the
  new bundle on disk but never swaps the running app. The new version starts on
  the next launch, or immediately via **OpenChat › Restart to Update**.
- Verifies before installing: the updater's minisign signature
  (`plugins.updater.pubkey`), then the extracted bundle must have the running
  app's Developer ID Team ID, pass Gatekeeper, and carry the advertised version.
- Never downgrades, and never shows network failures as errors.
- Automatic installs never trigger an admin password prompt: if the app's folder
  is not writable, the menu says an update is available and **Check for
  Updates…** installs it.
- **OpenChat › Install Updates Automatically** turns it off; **Check for
  Updates…** always works.

The app menu shows the running version and update state ("Version 0.1.24 — up
to date"). The same state is exposed to the client as
`window.__OPENCHAT_DESKTOP__`, which Settings › App version & updates shows as
"Mac app v… · Up to date". `OPENCHAT_UPDATE_FEED=<https url>` points a build at
a test feed.

## Release (one command)

```bash
# Bump the version in src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
# package.json, commit, then:
apps/desktop/scripts/release.sh --publish
```

It builds on this host, signs and notarizes on the Mac holding the IdeaFlow
Developer ID (`SIGN_HOST`, default `m5`; it runs inside that Mac's GUI session
via `tmux -L aqua` because the keychain is locked over plain SSH), signs the
update payload with the updater key, and publishes GitHub release
`desktop-v<version>` with:

- `OpenChat-macOS-arm64.dmg`: first install; the landing page links to
  `releases/latest/download/OpenChat-macOS-arm64.dmg`
- `OpenChat.app.tar.gz`: the auto-update payload
- `latest.json`: the feed installed apps poll at
  `releases/latest/download/latest.json`

Without `--publish` it stages everything in `dist/<version>/`. Configuration
(signing host and App Store Connect API key paths) is read from
`~/.config/openchat-desktop/release.env`. The updater private key is
`~/.config/openchat-desktop/updater.key`. Losing it means installed apps can no
longer update themselves, so keep a backup.
