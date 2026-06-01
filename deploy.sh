#!/bin/bash
set -e

SERVER_IP="3.216.129.34"
SSH_KEY="~/.ssh/lightsail-noos.pem"
REMOTE_USER="ubuntu"
APP_NAME="openchat"
APP_PORT="4001"

echo "=== Deploying $APP_NAME to $SERVER_IP ==="

# Build the legacy Vite client (served at /legacy/, kept for backward compat).
echo "Building legacy Vite client..."
VITE_NOOS_URL=https://globalbr.ai npm run build

# ────────────────────────────────────────────────────────────────────────────
# RN-web builds (OpenChat-601): single openchat-mobile checkout, two exports.
#
# The desktop-responsive branch has been folded into main. /m/ and /d/ are now
# the same app built twice — once with experiments.baseUrl=/m, once with /d.
# baseUrl is gated by IS_WEB_BUILD in app.config.js so native (EAS) builds
# never accidentally pick up a web baseUrl that would corrupt their deep
# links + asset mapping.
# ────────────────────────────────────────────────────────────────────────────

MOBILE_REPO="${MOBILE_REPO:-$HOME/code/openchat-mobile}"

# Clean target dirs that go into the docker build context.
rm -rf client-mobile/dist client-mobile-desktop/dist
mkdir -p client-mobile/dist client-mobile-desktop/dist

if [ -d "$MOBILE_REPO" ]; then
  echo ""
  echo "── Building openchat-mobile RN-web for /m/ ──"
  rm -rf "$MOBILE_REPO/dist-web-m"
  (
    cd "$MOBILE_REPO" && \
    IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/m npx expo export \
      --platform web --output-dir dist-web-m --clear
  )
  cp -r "$MOBILE_REPO/dist-web-m/." client-mobile/dist/

  echo ""
  echo "── Building openchat-mobile RN-web for /d/ ──"
  rm -rf "$MOBILE_REPO/dist-web-d"
  (
    cd "$MOBILE_REPO" && \
    IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/d npx expo export \
      --platform web --output-dir dist-web-d --clear
  )
  cp -r "$MOBILE_REPO/dist-web-d/." client-mobile-desktop/dist/

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
else
  echo ""
  echo "openchat-mobile repo not found at $MOBILE_REPO — /m and /d will serve placeholders."
  PLACEHOLDER='<!doctype html><meta charset=utf-8><title>OpenChat</title><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:0 auto;color:#444"><h1>Build unavailable</h1><p>The RN-web build was not present in this deploy package.</p></body>'
  echo "$PLACEHOLDER" > client-mobile/dist/index.html
  echo "$PLACEHOLDER" > client-mobile-desktop/dist/index.html
fi

# Create deployment package
echo ""
echo "Creating deployment package..."
tar -czf /tmp/${APP_NAME}-deploy.tar.gz \
  server/dist/ \
  server/package*.json \
  client/dist/ \
  client-mobile/dist/ \
  client-mobile-desktop/dist/ \
  package*.json \
  docker-compose.prod.yml \
  Dockerfile

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

# Rename docker-compose file
sudo mv docker-compose.prod.yml docker-compose.yml 2>/dev/null || true

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
