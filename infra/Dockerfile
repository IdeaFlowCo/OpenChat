FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy server package files
COPY apps/server/package*.json ./apps/server/

# Install server dependencies
WORKDIR /app/apps/server
RUN npm ci --omit=dev

# Copy built server files
COPY apps/server/dist/ ./dist/

# Copy legacy Vite web build (served at /legacy/)
WORKDIR /app
COPY apps/web/dist/ ./apps/web/dist/

# Copy mobile (RN-web) build, optional — served at /m/*.
# Created by deploy.sh from apps/mobile (formerly ../openchat-mobile/dist-web).
# Dockerfile COPY can't easily branch, so deploy.sh always produces SOMETHING
# at client-mobile/dist (even a placeholder) before the build.
COPY client-mobile/dist/ ./client-mobile/dist/

# Copy desktop-responsive RN-web build, served at /d/*. Same RN codebase as
# /m but with a responsive multi-pane layout above 768px.
COPY client-mobile-desktop/dist/ ./client-mobile-desktop/dist/

WORKDIR /app/apps/server

# Expose port
EXPOSE 4001

ENV NODE_ENV=production
ENV PORT=4001

# Start the server
CMD ["node", "dist/index.js"]
