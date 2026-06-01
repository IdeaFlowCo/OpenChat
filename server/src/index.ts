import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { marked } from 'marked';
import { initDatabase, closeDatabase } from './db.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import clientLogsRoutes from './routes/clientLogs.js';
import agentKeysRoutes from './routes/agentKeys.js';
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

const connectBotMdPath = path.join(__dirname, 'docs', 'connect-your-bot.md');
let connectBotHtmlCache: string | null = null;

function renderConnectBotHtml(): string {
  if (connectBotHtmlCache) return connectBotHtmlCache;
  let body = '';
  try {
    body = marked.parse(readFileSync(connectBotMdPath, 'utf8'), { async: false }) as string;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    body = `<p>Failed to load docs: ${message}</p>`;
  }

  connectBotHtmlCache = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your bot - OpenChat</title>
<style>
  :root { color-scheme: dark; --bg:#0a0c18; --surface:#12162a; --border:#29304f; --text:#f5f7ff; --muted:#a7aecf; --accent:#8ea2ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:820px; margin:0 auto; padding:32px 22px 72px; }
  a { color:var(--accent); }
  h1 { font-size:40px; line-height:1.1; margin:24px 0; }
  h2 { margin-top:36px; }
  p, li { color:var(--text); }
  code { background:var(--surface); border:1px solid var(--border); border-radius:5px; padding:2px 5px; }
  pre { overflow:auto; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:16px; }
  pre code { border:0; padding:0; }
  table { width:100%; border-collapse:collapse; margin:16px 0; }
  th, td { border-bottom:1px solid var(--border); padding:9px 11px; text-align:left; }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return connectBotHtmlCache;
}

app.get('/about/connect-your-bot', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('html').send(renderConnectBotHtml());
});

// Serve static files from client build (production)
const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/client-logs', clientLogsRoutes);
app.use('/api/agent-keys', agentKeysRoutes);

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
