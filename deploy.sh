#!/bin/bash
set -e

SERVER_IP="3.216.129.34"
SSH_KEY="~/.ssh/lightsail-noos.pem"
REMOTE_USER="ubuntu"
APP_NAME="openchat"
APP_PORT="4001"

echo "=== Deploying $APP_NAME to $SERVER_IP ==="

# Build locally with production URLs
echo "Building..."
VITE_NOOS_URL=https://globalbr.ai npm run build

# Build openchat-mobile (RN-web) if its repo is sitting alongside.
# The web export lands at $MOBILE_REPO/dist-web; we copy it under
# ./client-mobile/dist for the docker COPY. Skipped silently if the sibling
# repo doesn't exist on this machine; Dockerfile expects the directory so
# we always at least drop a placeholder so `docker build` doesn't choke.
MOBILE_REPO="${MOBILE_REPO:-$HOME/code/openchat-mobile}"
rm -rf client-mobile/dist
mkdir -p client-mobile/dist
if [ -d "$MOBILE_REPO" ]; then
  echo "Building openchat-mobile (RN-web) from $MOBILE_REPO..."
  (cd "$MOBILE_REPO" && npx expo export --platform web --output-dir dist-web --clear)
  cp -r "$MOBILE_REPO/dist-web/." client-mobile/dist/
else
  echo "openchat-mobile repo not found at $MOBILE_REPO — /m will serve a placeholder."
  cat > client-mobile/dist/index.html <<'PLACEHOLDER_HTML'
<!doctype html><meta charset=utf-8><title>OpenChat /m</title>
<body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:0 auto;color:#444">
<h1>/m placeholder</h1>
<p>The React Native web build of openchat-mobile isn't present in this deploy. Set <code>MOBILE_REPO</code> on the deploy host (or place a sibling <code>openchat-mobile/</code> checkout next to <code>openchat/</code>) and redeploy.</p>
</body>
PLACEHOLDER_HTML
fi

# Build openchat-mobile-desktop (same RN codebase, responsive layout) if its
# sibling worktree is present. Mounted at /d on the openchat server. See
# /Users/Jacob/code/openchat-mobile-desktop/app.json (experiments.baseUrl="/d")
# and server/src/index.ts for the static mount. The dist always exists in the
# tarball so the Dockerfile COPY doesn't fail in non-developer environments.
MOBILE_DESKTOP_REPO="${MOBILE_DESKTOP_REPO:-$HOME/code/openchat-mobile-desktop}"
rm -rf client-mobile-desktop/dist
mkdir -p client-mobile-desktop/dist
if [ -d "$MOBILE_DESKTOP_REPO" ]; then
  echo "Building openchat-mobile-desktop (RN-web, responsive) from $MOBILE_DESKTOP_REPO..."
  (cd "$MOBILE_DESKTOP_REPO" && npx expo export --platform web --output-dir dist-web --clear)
  cp -r "$MOBILE_DESKTOP_REPO/dist-web/." client-mobile-desktop/dist/
else
  echo "openchat-mobile-desktop repo not found at $MOBILE_DESKTOP_REPO — using openchat-mobile RN-web build for /d."
  if [ -f client-mobile/dist/index.html ]; then
    cp -r client-mobile/dist/. client-mobile-desktop/dist/
    # The Expo export was built with baseUrl=/m. For the /d mount, rewrite
    # top-level static asset references so the same checked-in RN app can serve
    # both web entrypoints instead of letting /d drift from an untracked fork.
    find client-mobile-desktop/dist -type f \( -name '*.html' -o -name '*.json' \) -print0 \
      | xargs -0 perl -pi -e 's#/m/#/d/#g; s#"/m"#"/d"#g'
  else
    cat > client-mobile-desktop/dist/index.html <<'PLACEHOLDER_HTML'
<!doctype html><meta charset=utf-8><title>OpenChat /d</title>
<body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:0 auto;color:#444">
<h1>/d unavailable</h1>
<p>The React Native web build was not present in this deploy package.</p>
</body>
PLACEHOLDER_HTML
  fi
fi

# Create deployment package
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
