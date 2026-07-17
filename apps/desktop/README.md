# OpenChat Desktop

A thin desktop shell around the OpenChat **react-native-web** build (from
`apps/mobile`). It ships the exact same responsive UI as the browser build —
wide windows get the master-detail split view, narrow windows collapse to the
phone layout — inside a native window frame.

This is a **wrapper only**. There is no separate desktop UI codebase; all
product code lives in `apps/mobile/src`. API + socket usage is identical to the
mobile/browser build (it talks to the same `chat.globalbr.ai` backend).

> Do not confuse this with `apps/web` (the standalone Vite client). This wrapper
> bundles the RNW export, `apps/web` stays the default web app in parallel.

## The shippable deliverable

The **primary deliverable is the responsive RNW web build itself** — it runs in
any browser and is what `chat.globalbr.ai` serves at `/d` (desktop) and `/m`
(mobile). Build it with:

```bash
cd apps/mobile
npm run export:web:desktop   # -> dist-web-d  (assets under /d/, for chat.globalbr.ai/d)
npm run export:web:app       # -> dist-web-app (root-relative assets, for a bundled shell)
```

Open `dist-web-app/index.html` through any static server to see the desktop
split-view. Resize the window across ~900px to watch it collapse to the phone
layout and back.

## Building the native app (Tauri)

Tauri is chosen over Electron for a ~10x smaller binary (system WebView instead
of a bundled Chromium). The config here (`src-tauri/tauri.conf.json`) is a
standard Tauri v2 setup — no custom Rust beyond the boilerplate entry point.

**Prerequisites** (one-time, not installed in CI by default):

- Rust toolchain — `curl https://sh.rustup.rs -sSf | sh`
- Platform WebView deps — macOS: nothing extra; Linux: `webkit2gtk`; Windows:
  WebView2 (preinstalled on Win 11).
- App icons in `src-tauri/icons/` — generate from `apps/mobile/assets/icon.png`
  with `npx @tauri-apps/cli icon apps/mobile/assets/icon.png`. (Not committed;
  Tauri requires them at build time.)

**Build:**

```bash
cd apps/desktop
npm install
npm run build:web   # exports apps/mobile -> ../mobile/dist-web-app
npm run build:tauri # tauri build -> native installer in src-tauri/target/release/bundle
# or: npm run dev    # starts Expo web on port 8081, then opens the Tauri dev window
```

`tauri.conf.json`'s `frontendDist` points at `../../mobile/dist-web-app`, and
`beforeBuildCommand` re-runs the web export so `npm run build:tauri` is one step.
For local development, `beforeDevCommand` starts the mobile web server that
`devUrl` loads.

## Electron alternative (follow-up)

If a Tauri toolchain isn't viable (e.g. a build host without Rust), an Electron
wrapper is a drop-in alternative and is left as a documented follow-up:

1. `npm i -D electron electron-builder` in a sibling `apps/desktop-electron`.
2. A ~20-line `main.js` that `BrowserWindow.loadFile('dist-web-app/index.html')`
   with `width: 1100, height: 760, minWidth: 380`.
3. `electron-builder` config pointing `files` at the same `dist-web-app` export.

Electron produces a larger binary (~150MB vs ~10MB) but needs no Rust and works
on any Node host. The responsive RNW build is identical either way — the shell
is interchangeable.
