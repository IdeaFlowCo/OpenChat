#!/bin/bash
# Builds the responsive RN-web app into client-app/dist (served at /app).
# Used by infra/deploy.sh and by .github/workflows/web-bundle.yml, so the
# bundle can be produced on a CI runner instead of a memory-constrained host.
set -euo pipefail

# Run from repo root.
cd "$(dirname "$0")/.."

# ────────────────────────────────────────────────────────────────────────────
# RN-web build (OpenChat-601): one source, one responsive export.
#
# Post-monorepo (openchat-3jq.5): the mobile app now lives in-repo at
# apps/mobile (no longer a sibling repo). MOBILE_REPO defaults to that, but
# can be overridden for backwards compat during the transition window.
# ────────────────────────────────────────────────────────────────────────────

MOBILE_REPO="${MOBILE_REPO:-$(pwd)/apps/mobile}"

# Clean the target directory that goes into the Docker build context.
rm -rf client-app/dist
mkdir -p client-app/dist

if [ -d "$MOBILE_REPO" ]; then
  echo ""
  echo "── Building the responsive OpenChat web app for /app/ ──"
  rm -rf "$MOBILE_REPO/dist-web-app"
  (
    cd "$MOBILE_REPO" && \
    IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/app npx expo export \
      --platform web --output-dir dist-web-app --clear
  )
  cp -r "$MOBILE_REPO/dist-web-app/." client-app/dist/

  APP_HTML="client-app/dist/index.html"
  if [ ! -f "$APP_HTML" ] || ! grep -q '/app/' "$APP_HTML"; then
    echo "ERROR: canonical /app/ RN-web export is missing or has the wrong base URL"
    exit 1
  fi

  # ── PWA assets for /app/ (OpenChat-3rw) ──────────────────────────────────
  # Copies a manifest, service worker, and icons into the deployed /app/ dist,
  # and injects the <link rel="manifest"> + sw registration into index.html
  # at build time so the same RN-web bundle becomes an installable app.
  echo ""
  echo "── Injecting PWA manifest + service worker into /app/ build ──"

  PWA_SRC="$(pwd)/apps/server/src/d-pwa"
  if [ -d "$PWA_SRC" ]; then
    cp "$PWA_SRC/manifest.webmanifest" client-app/dist/manifest.webmanifest
    cp "$PWA_SRC/sw.js"                client-app/dist/sw.js
    cp "$PWA_SRC/icon-192.png"         client-app/dist/icon-192.png
    cp "$PWA_SRC/icon-512.png"         client-app/dist/icon-512.png

    # Inject PWA tags before </head> on /app/ index.html. Uses a portable
    # perl one-liner so it works on both macOS BSD sed and GNU sed.
    perl -i -pe '
      s|</head>|<link rel="manifest" href="/app/manifest.webmanifest"><meta name="theme-color" content="#5664e2"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="OpenChat"><link rel="apple-touch-icon" href="/app/icon-192.png"><script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/app/sw.js",{scope:"/app/"}).catch(function(e){console.warn("SW registration failed",e)})})}</script></head>|
    ' client-app/dist/index.html

    if grep -q "manifest.webmanifest" client-app/dist/index.html; then
      echo "  ✓ PWA manifest + service worker injected into /app/ index.html"
    else
      echo "ERROR: PWA injection failed — </head> not matched in dist-web-app/index.html"
      exit 1
    fi
  else
    echo "  (skip — apps/server/src/d-pwa/ not present; PWA install will not be available)"
  fi
else
  echo ""
  echo "OpenChat RN source not found at $MOBILE_REPO — /app will serve a placeholder."
  PLACEHOLDER='<!doctype html><meta charset=utf-8><title>OpenChat</title><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:0 auto;color:#444"><h1>Build unavailable</h1><p>The RN-web build was not present in this deploy package.</p></body>'
  echo "$PLACEHOLDER" > client-app/dist/index.html
fi
