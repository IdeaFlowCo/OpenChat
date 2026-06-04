#!/bin/bash
set -e

# Run from repo root.
cd "$(dirname "$0")/.."

SERVER_IP="3.216.129.34"
SSH_KEY="~/.ssh/lightsail-noos.pem"
REMOTE_USER="ubuntu"
APP_NAME="openchat"
APP_PORT="4001"

echo "=== Deploying $APP_NAME to $SERVER_IP ==="

# Build the legacy Vite web client (served at /legacy/, kept for backward compat).
echo "Building legacy Vite web client..."
VITE_NOOS_URL=https://globalbr.ai npm run build --workspace=apps/web

# Build the server (compiles TS + copies static assets into dist/).
echo "Building server..."
npm run build --workspace=apps/server

# ────────────────────────────────────────────────────────────────────────────
# RN-web builds (OpenChat-601): single openchat-mobile source, two exports.
#
# Post-monorepo (openchat-3jq.5): the mobile app now lives in-repo at
# apps/mobile (no longer a sibling repo). MOBILE_REPO defaults to that, but
# can be overridden for backwards compat during the transition window.
# ────────────────────────────────────────────────────────────────────────────

MOBILE_REPO="${MOBILE_REPO:-$(pwd)/apps/mobile}"

# ── RN-web export helper (openchat-3jq.4) ────────────────────────────────────
# Factored out so the /m and /d builds share one definition. Behavior is
# IDENTICAL to the previous inline blocks: clear Metro cache, set the web-only
# baseUrl gate, export, then copy into the deploy target.
#
#   export_rnweb <baseUrl> <out-dir-name> <dest-dist-dir>
#
# See docs/collapse-m-d.md for why we still export twice by default.
export_rnweb() {
  local base_url="$1" out_dir="$2" dest="$3"
  echo ""
  echo "── Building openchat-mobile RN-web for ${base_url}/ ──"
  rm -rf "$MOBILE_REPO/$out_dir"
  (
    cd "$MOBILE_REPO" && \
    IS_WEB_BUILD=1 OPENCHAT_BASE_URL="$base_url" npx expo export \
      --platform web --output-dir "$out_dir" --clear
  )
  cp -r "$MOBILE_REPO/$out_dir/." "$dest/"
}

# Clean target dirs that go into the docker build context.
rm -rf client-mobile/dist client-mobile-desktop/dist
mkdir -p client-mobile/dist client-mobile-desktop/dist

if [ -d "$MOBILE_REPO" ]; then
  if [ "${OPENCHAT_SINGLE_RNWEB_EXPORT:-0}" = "1" ]; then
    # ── EXPERIMENTAL single-export path (opt-in; default OFF) ────────────────
    # Export /d ONCE, then derive /m by copying + rewriting /d/→/m/ asset
    # references in index.html (Option 3 in docs/collapse-m-d.md). This halves
    # Metro export time but is NOT prod-blessed yet — keep it behind the flag.
    echo ""
    echo "── [experimental] single RN-web export: /d → derive /m ──"
    export_rnweb /d dist-web-d client-mobile-desktop/dist
    cp -r client-mobile-desktop/dist/. client-mobile/dist/
    # Rewrite absolute /d/ asset refs to /m/ in the derived /m index.html.
    perl -i -pe 's{/d/}{/m/}g' client-mobile/dist/index.html
    echo "  (derived /m from /d; see docs/collapse-m-d.md for risk notes)"
  else
    # ── DEFAULT two-export path (unchanged behavior) ─────────────────────────
    export_rnweb /m dist-web-m client-mobile/dist
    export_rnweb /d dist-web-d client-mobile-desktop/dist
  fi

  # ── CROSS-CONTAMINATION VALIDATOR (Codex catch 2026-06-01) ────────────────
  # Two sequential expo export runs from the same Metro cache could leak the
  # wrong baseUrl into the output if our app.config.js gate or the --clear
  # flag fails to do its job. Verify each output references ONLY its own
  # base path, and fail loudly otherwise — a silent baseUrl mix-up causes
  # 404s on every JS/CSS asset request in the affected build.
  echo ""
  echo "── Validating bundle baseUrl integrity ──"

  M_HTML="client-mobile/dist/index.html"
  D_HTML="client-mobile-desktop/dist/index.html"

  if [ ! -f "$M_HTML" ]; then
    echo "ERROR: $M_HTML missing — /m/ export failed silently"
    exit 1
  fi
  if [ ! -f "$D_HTML" ]; then
    echo "ERROR: $D_HTML missing — /d/ export failed silently"
    exit 1
  fi

  # /m/ output must reference /m/ paths and NOT /d/ paths.
  if ! grep -q '/m/' "$M_HTML"; then
    echo "ERROR: /m/ export at $M_HTML has no /m/ asset references — baseUrl gate may have failed"
    exit 1
  fi
  if grep -q '/d/' "$M_HTML"; then
    echo "ERROR: /m/ export at $M_HTML contains /d/ references — cross-contamination from desktop build"
    grep -n '/d/' "$M_HTML" | head -3
    exit 1
  fi

  # /d/ output must reference /d/ paths and NOT /m/ paths.
  if ! grep -q '/d/' "$D_HTML"; then
    echo "ERROR: /d/ export at $D_HTML has no /d/ asset references — baseUrl gate may have failed"
    exit 1
  fi
  if grep -q '/m/' "$D_HTML"; then
    echo "ERROR: /d/ export at $D_HTML contains /m/ references — cross-contamination from mobile build"
    grep -n '/m/' "$D_HTML" | head -3
    exit 1
  fi

  echo "  ✓ /m/ references only /m/ paths"
  echo "  ✓ /d/ references only /d/ paths"

  # ── PWA assets for /d/ (OpenChat-3rw) ────────────────────────────────────
  # Make /d/ installable from Chrome / Edge / Brave / Safari Sonoma+.
  # Copies a manifest, service worker, and icons into the deployed /d/ dist,
  # and injects the <link rel="manifest"> + sw registration into index.html
  # at build time so the same RN-web bundle becomes an installable app.
  echo ""
  echo "── Injecting PWA manifest + sw into /d/ build ──"

  PWA_SRC="$(pwd)/apps/server/src/d-pwa"
  if [ -d "$PWA_SRC" ]; then
    cp "$PWA_SRC/manifest.webmanifest" client-mobile-desktop/dist/manifest.webmanifest
    cp "$PWA_SRC/sw.js"                client-mobile-desktop/dist/sw.js
    cp "$PWA_SRC/icon-192.png"         client-mobile-desktop/dist/icon-192.png
    cp "$PWA_SRC/icon-512.png"         client-mobile-desktop/dist/icon-512.png

    # Inject PWA tags before </head> on /d/ index.html. Uses a portable
    # perl one-liner so it works on both macOS BSD sed and GNU sed.
    perl -i -pe '
      s|</head>|<link rel="manifest" href="/d/manifest.webmanifest"><meta name="theme-color" content="#5664e2"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="OpenChat"><link rel="apple-touch-icon" href="/d/icon-192.png"><script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/d/sw.js",{scope:"/d/"}).catch(function(e){console.warn("SW registration failed",e)})})}</script></head>|
    ' client-mobile-desktop/dist/index.html

    if grep -q "manifest.webmanifest" client-mobile-desktop/dist/index.html; then
      echo "  ✓ PWA manifest + sw injected into /d/ index.html"
    else
      echo "ERROR: PWA injection failed — </head> not matched in dist-web-d/index.html"
      exit 1
    fi
  else
    echo "  (skip — apps/server/src/d-pwa/ not present; PWA install will not be available)"
  fi
else
  echo ""
  echo "openchat-mobile source not found at $MOBILE_REPO — /m and /d will serve placeholders."
  PLACEHOLDER='<!doctype html><meta charset=utf-8><title>OpenChat</title><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:0 auto;color:#444"><h1>Build unavailable</h1><p>The RN-web build was not present in this deploy package.</p></body>'
  echo "$PLACEHOLDER" > client-mobile/dist/index.html
  echo "$PLACEHOLDER" > client-mobile-desktop/dist/index.html
fi

# Create deployment package
echo ""
echo "Creating deployment package..."
# Stage Dockerfile + docker-compose at the tar root so the remote extract
# Just Works without restructuring on the server side.
cp infra/Dockerfile /tmp/oc-Dockerfile
cp infra/docker-compose.prod.yml /tmp/oc-docker-compose.prod.yml

tar -czf /tmp/${APP_NAME}-deploy.tar.gz \
  apps/server/dist/ \
  apps/server/package*.json \
  apps/web/dist/ \
  client-mobile/dist/ \
  client-mobile-desktop/dist/ \
  package*.json \
  -C /tmp oc-docker-compose.prod.yml oc-Dockerfile

# Copy to server
echo "Copying to server..."
scp -i $SSH_KEY -o StrictHostKeyChecking=no /tmp/${APP_NAME}-deploy.tar.gz $REMOTE_USER@$SERVER_IP:/tmp/

# Deploy on server
echo "Deploying on server..."
ssh -i $SSH_KEY -o StrictHostKeyChecking=no $REMOTE_USER@$SERVER_IP << ENDSSH
set -e

# Setup app directory
sudo mkdir -p /opt/$APP_NAME
cd /opt/$APP_NAME

# Extract deployment
sudo tar -xzf /tmp/${APP_NAME}-deploy.tar.gz

# Rename staged docker artifacts into place
sudo mv oc-docker-compose.prod.yml docker-compose.yml 2>/dev/null || true
sudo mv oc-Dockerfile Dockerfile 2>/dev/null || true

# Create .env if not exists
if [ ! -f .env ]; then
    echo "Creating .env template - PLEASE ADD SECRETS"
    sudo tee .env << 'EOF'
NEO4J_URI=bolt://noos_neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=CHANGE_ME
JWT_SECRET=CHANGE_ME
NOOS_API_URL=http://noos_api:4000/api
NOOS_URL=https://globalbr.ai
OPENCHAT_URL=https://chat.globalbr.ai
EOF
fi

# Start services
echo "Starting $APP_NAME..."
sudo docker compose down 2>/dev/null || true
sudo docker compose up -d --build

# Show logs
echo "Recent logs:"
sudo docker compose logs --tail=20

echo ""
echo "=== $APP_NAME deployment complete ==="
ENDSSH

echo ""
echo "=== Deployment finished ==="
echo "App should be available at port $APP_PORT on $SERVER_IP"
