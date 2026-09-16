#!/bin/bash
set -euo pipefail

# Run from repo root.
cd "$(dirname "$0")/.."

GCP_PROJECT="${GCP_PROJECT:-lightsail-migration}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-noos}"
APP_NAME="openchat"
APP_PORT="4001"

echo "=== Deploying $APP_NAME to $GCP_INSTANCE ($GCP_PROJECT/$GCP_ZONE) ==="

# Build the server (compiles TS + copies static assets into dist/).
echo "Building server..."
npm run build --workspace=apps/server

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
  client-app/dist/ \
  package*.json \
  -C /tmp oc-docker-compose.prod.yml oc-Dockerfile

# Copy to the production GCE instance. Explicit project/zone flags keep this
# safe when the operator's active gcloud configuration points elsewhere.
echo "Copying to GCP instance..."
gcloud compute scp "/tmp/${APP_NAME}-deploy.tar.gz" "$GCP_INSTANCE:/tmp/${APP_NAME}-deploy.tar.gz" \
  --project="$GCP_PROJECT" \
  --zone="$GCP_ZONE"

# Deploy on server
echo "Deploying on server..."
gcloud compute ssh "$GCP_INSTANCE" \
  --project="$GCP_PROJECT" \
  --zone="$GCP_ZONE" \
  --command="sudo env APP_NAME=$APP_NAME bash -s" << 'ENDSSH'
set -euo pipefail

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
# Verify-only key matching Noos JWT_SECRET; OpenChat still signs with JWT_SECRET.
NOOS_JWT_SECRET=CHANGE_ME
OC_BRIDGE_SECRET=CHANGE_ME
NOOS_API_URL=http://noos_api:4000/api
NOOS_URL=https://globalbr.ai
OPENCHAT_URL=https://chat.globalbr.ai
EOF
fi

# Start services
echo "Starting $APP_NAME..."
sudo docker compose up -d --build --remove-orphans

# Show logs
echo "Recent logs:"
sudo docker compose logs --tail=20

echo ""
echo "=== $APP_NAME deployment complete ==="
ENDSSH

echo ""
echo "=== Deployment finished ==="
echo "App should be available at port $APP_PORT on GCP instance $GCP_INSTANCE"
