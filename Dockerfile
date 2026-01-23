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

WORKDIR /app/server

# Expose port
EXPOSE 4001

ENV NODE_ENV=production
ENV PORT=4001

# Start the server
CMD ["node", "dist/index.js"]
