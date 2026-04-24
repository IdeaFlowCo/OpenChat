import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { initDatabase, closeDatabase } from './db.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import clientLogsRoutes from './routes/clientLogs.js';
import { setupChatSocket } from './websocket/chatHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const app = express();
const httpServer = createServer(app);

// CORS configuration
const allowedOrigins = [
  'http://localhost:29231',
  'https://chat.globalbr.ai',
  process.env.CORS_ORIGIN
].filter(Boolean) as string[];

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files from client build (production)
const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/client-logs', clientLogsRoutes);

// Make io available to HTTP route handlers (e.g. to emit conversation:created
// when a new conversation is created via POST /api/chat/conversations).
app.set('io', io);

// Setup WebSocket handlers
setupChatSocket(io);

// SPA fallback - serve index.html for all non-API routes
app.use((_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Start server
const PORT = parseInt(process.env.PORT || '41851', 10);

async function start() {
  try {
    await initDatabase();
    console.log('Connected to Neo4j database');

    httpServer.listen(PORT, () => {
      console.log(`OpenChat server running on http://localhost:${PORT}`);
      console.log(`WebSocket server ready`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await closeDatabase();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await closeDatabase();
  process.exit(0);
});

start();
