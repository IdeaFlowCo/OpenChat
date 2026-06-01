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
import pushRoutes from './routes/push.js';
import legalRoutes from './routes/legal.js';
import aiRoutes from './routes/ai.js';
import thoughtsRoutes from './routes/thoughts.js';
import { setupChatSocket } from './websocket/chatHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const app = express();

// Behind Cloudflare → nginx → docker. Trust forwarded headers so req.protocol
// and req.ip reflect the real client, not the immediate hop. Without this the
// default redirect_uri built by /api/auth/google/url falls back to http://
// even when the user came in over HTTPS (OpenChat-9jm).
app.set('trust proxy', true);

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

// Project landing page (/about) — single static HTML + the app icon.
// Lists every version of OpenChat (iOS TestFlight, Android APK, Mobile Web,
// Desktop Web) so we have one shareable URL that branches to all platforms.
// Must be registered BEFORE express.static(clientDistPath) below so it
// takes precedence over any /about path the Vite client might claim.
const landingHtmlPath = path.join(__dirname, 'landing.html');
const landingIconPath = path.join(__dirname, 'landing-icon.png');
app.get('/about', (_req, res) => {
  res.sendFile(landingHtmlPath);
});
app.get('/about/icon.png', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(landingIconPath);
});

// Serve static files from client build (production)
const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// Optional RN-web build of openchat-mobile, mounted at /m/*. Lets us experiment
// with the React Native app on the web without disturbing the existing /
// client. Built by deploy.sh from sibling openchat-mobile repo via
// `npx expo export --platform web` (with app.json experiments.baseUrl=/m).
// If the dist directory is missing this just no-ops (404 under /m).
const mobileDistPath = path.join(__dirname, '..', '..', 'client-mobile', 'dist');
app.use('/m', express.static(mobileDistPath));
// SPA fallback for the mobile app's own client-side routes. Only matches
// /m and /m/<anything>; must run BEFORE the catch-all SPA fallback below.
app.get(/^\/m(\/|$)/, (_req, res, next) => {
  res.sendFile(path.join(mobileDistPath, 'index.html'), (err) => {
    if (err) next();
  });
});

// Desktop-responsive RN-web build, mounted at /d/*. Same codebase as /m but
// with a multi-pane master-detail layout above the 768px breakpoint. Built
// from sibling openchat-mobile-desktop repo (experiments.baseUrl=/d).
const mobileDesktopDistPath = path.join(__dirname, '..', '..', 'client-mobile-desktop', 'dist');
app.use('/d', express.static(mobileDesktopDistPath));
app.get(/^\/d(\/|$)/, (_req, res, next) => {
  res.sendFile(path.join(mobileDesktopDistPath, 'index.html'), (err) => {
    if (err) next();
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/client-logs', clientLogsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/thoughts', thoughtsRoutes);

// Legal pages (OpenChat-wfz)
app.use('/legal', legalRoutes);

// Make io available to HTTP route handlers (e.g. to emit conversation:created
// when a new conversation is created via POST /api/chat/conversations).
app.set('io', io);

// Setup WebSocket handlers
setupChatSocket(io);

// Group invite deep-link: /i/<token> → serve the web SPA which handles this
// route via the React Router /i/:token route. The SPA reads the token from the
// URL and calls GET /api/chat/invites/:token to show the preview. (OpenChat-240)
app.get('/i/:token', (_req, res, next) => {
  res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
    if (err) next();
  });
});

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
