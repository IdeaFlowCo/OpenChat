#!/bin/bash
set -e

SERVER_IP="44.211.180.200"
SSH_KEY="~/.ssh/lightsail-noos.pem"
REMOTE_USER="ubuntu"
APP_NAME="openchat"
APP_PORT="4001"

echo "=== Deploying $APP_NAME to $SERVER_IP ==="

# Build locally
echo "Building..."
npm run build

# Create deployment package
echo "Creating deployment package..."
tar -czf /tmp/${APP_NAME}-deploy.tar.gz \
  server/dist/ \
  server/package*.json \
  client/dist/ \
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
