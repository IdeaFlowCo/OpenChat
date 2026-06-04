FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy server package files
COPY server/package*.json ./server/

# Install server dependencies
WORKDIR /app/server
RUN npm ci --only=production

# Copy built server files
COPY server/dist/ ./dist/

# Copy client build (served by server or nginx)
WORKDIR /app
COPY client/dist/ ./client/dist/

# Copy mobile (RN-web) build, optional — served at /m/*.
# Created by deploy.sh from ../openchat-mobile/dist-web. Dockerfile COPY can't
# easily branch, so we ensure deploy.sh always produces SOMETHING here (even
# an empty marker) before the build. If you ever want to remove the /m route
# entirely, also delete this line + the /m server mount.
COPY client-mobile/dist/ ./client-mobile/dist/

# Copy desktop-responsive RN-web build, served at /d/*. Same codebase as
# /m but with a responsive multi-pane layout above 768px. Built by deploy.sh
# from ../openchat-mobile-desktop/dist-web; falls back to a placeholder if
# the sibling repo is absent.
COPY client-mobile-desktop/dist/ ./client-mobile-desktop/dist/

WORKDIR /app/server

# Expose port
EXPOSE 4001

ENV NODE_ENV=production
ENV PORT=4001

# Start the server
CMD ["node", "dist/index.js"]
