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

# Copy the single responsive RN-web build served at /app/*. The same bundle
# renders compact or split-pane layouts based on width and user preference.
WORKDIR /app
COPY client-app/dist/ ./client-app/dist/

WORKDIR /app/apps/server

# Expose port
EXPOSE 4001

ENV NODE_ENV=production
ENV PORT=4001

# Start the server
CMD ["node", "dist/index.js"]
