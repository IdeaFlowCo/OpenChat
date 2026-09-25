# OpenChat Desktop

A native Tauri window around the **live** OpenChat client at
`https://chat.globalbr.ai/app/` — the same react-native-web build of
`apps/mobile` that browsers get. There is no desktop UI codebase and no bundled
copy of the client.

## Why it loads the live URL instead of bundling the export

Loading `/app/` from its real origin is what makes desktop share state with
mobile and web:

- **Same origin, same auth.** A bundled build runs from `tauri://localhost`,
  which is not in the server's CORS allowlist (`apps/server/src/index.ts`) and
  breaks the redirect sign-in flows, whose callback URIs are derived from
  `window.location.origin`. Loaded from `chat.globalbr.ai`, every existing login
  path works unchanged, with no server change.
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

The bundle is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), not
Developer ID signed or notarized. Users must allow the first launch once:
**System Settings → Privacy & Security → Open Anyway**. Removing that step needs
an Apple Developer ID Application certificate plus notarization.

The icons in `src-tauri/icons/` are generated from `apps/mobile/assets/icon.png`
(`npx @tauri-apps/cli@2.11.2 icon ../mobile/assets/icon.png -o src-tauri/icons`).

The root `npm run build` deliberately skips `openchat-desktop`; build it
explicitly from here.

## Distribution

The landing page links to
`https://github.com/IdeaFlowCo/OpenChat/releases/latest/download/OpenChat-macOS-arm64.dmg`.
To ship a new build, attach the DMG to a GitHub release under exactly that asset
name:

```bash
cp src-tauri/target/release/bundle/dmg/OpenChat_*_aarch64.dmg OpenChat-macOS-arm64.dmg
gh release create desktop-v<version> OpenChat-macOS-arm64.dmg --title "OpenChat for Mac <version>"
```
