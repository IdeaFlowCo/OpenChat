#!/bin/bash
set -euo pipefail

# Run from repo root.
cd "$(dirname "$0")/.."

GCP_PROJECT="${GCP_PROJECT:-lightsail-migration}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-noos}"
GCP_ACCOUNT="${GCP_ACCOUNT:-874749606899-compute@developer.gserviceaccount.com}"
APP_NAME="openchat"
APP_PORT="4001"

echo "=== Deploying $APP_NAME to $GCP_INSTANCE ($GCP_PROJECT/$GCP_ZONE) ==="

# Build the server (compiles TS + copies static assets into dist/).
echo "Building server..."
npm run build --workspace=apps/server

# ────────────────────────────────────────────────────────────────────────────
# RN-web bundle for /app. By default it is built here (infra/build-web.sh).
# On a constrained machine, download the CI artifact from
# .github/workflows/web-bundle.yml for the commit being deployed and pass it:
#   CLIENT_DIST_DIR=/path/to/extracted/artifact bash infra/deploy.sh
# ────────────────────────────────────────────────────────────────────────────
if [ -n "${CLIENT_DIST_DIR:-}" ]; then
  if [ ! -f "$CLIENT_DIST_DIR/index.html" ] || ! grep -q '/app/' "$CLIENT_DIST_DIR/index.html"; then
    echo "ERROR: CLIENT_DIST_DIR does not contain an /app/ RN-web export"
    exit 1
  fi
  echo "Using prebuilt web bundle from $CLIENT_DIST_DIR"
  rm -rf client-app/dist
  mkdir -p client-app/dist
  cp -r "$CLIENT_DIST_DIR/." client-app/dist/
else
  bash infra/build-web.sh
fi

# Create deployment package
echo ""
echo "Creating deployment package..."
DEPLOY_ARCHIVE=$(mktemp "/tmp/${APP_NAME}-deploy.XXXXXX")
trap 'rm -f "$DEPLOY_ARCHIVE"' EXIT
# Stage Dockerfile + docker-compose at the tar root so the remote extract
# Just Works without restructuring on the server side.
cp infra/Dockerfile /tmp/oc-Dockerfile
cp infra/docker-compose.prod.yml /tmp/oc-docker-compose.prod.yml

tar -czf "$DEPLOY_ARCHIVE" \
  apps/server/dist/ \
  apps/server/package*.json \
  client-app/dist/ \
  package*.json \
  -C /tmp oc-docker-compose.prod.yml oc-Dockerfile

# Copy to the production GCE instance. Explicit project/zone flags keep this
# safe when the operator's active gcloud configuration points elsewhere.
echo "Copying to GCP instance..."
gcloud compute scp "$DEPLOY_ARCHIVE" "$GCP_INSTANCE:$DEPLOY_ARCHIVE" \
  --account="$GCP_ACCOUNT" \
  --project="$GCP_PROJECT" \
  --zone="$GCP_ZONE"

# Deploy on server
echo "Deploying on server..."
gcloud compute ssh "$GCP_INSTANCE" \
  --account="$GCP_ACCOUNT" \
  --project="$GCP_PROJECT" \
  --zone="$GCP_ZONE" \
  --command="sudo env APP_NAME=$APP_NAME DEPLOY_ARCHIVE=$DEPLOY_ARCHIVE bash -s" << 'ENDSSH'
set -euo pipefail

# Setup app directory
sudo mkdir -p /opt/$APP_NAME
cd /opt/$APP_NAME

# Extract deployment
sudo tar -xzf "$DEPLOY_ARCHIVE"
sudo rm -f "$DEPLOY_ARCHIVE"

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
OPENCHAT_URL=https://chat.ideaflow.app
# Friends-only beta directory. Change to 0 and redeploy to require a query.
OPENCHAT_OPEN_USER_DIRECTORY=1
# Stage IdeaFlow ID credentials separately, then switch this to true only
# after the registered callback has passed a production smoke test.
IDEAFLOW_ID_ENABLED=false
IDEAFLOW_ID_ISSUER=https://id.ideaflow.app/api/auth
IDEAFLOW_ID_CLIENT_ID=
IDEAFLOW_ID_CLIENT_SECRET=
IDEAFLOW_ID_REDIRECT_URI=https://chat.ideaflow.app/auth/ideaflow/callback
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
