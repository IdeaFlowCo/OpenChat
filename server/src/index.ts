import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { initDatabase, closeDatabase, getDriver } from './db.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import clientLogsRoutes from './routes/clientLogs.js';
import pushRoutes from './routes/push.js';
import legalRoutes from './routes/legal.js';
import aiRoutes from './routes/ai.js';
import thoughtsRoutes from './routes/thoughts.js';
import agentKeysRoutes from './routes/agentKeys.js';
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

// Project landing page (/, /about) — OpenChat-e4n moved / to landing.
// Single static HTML + the app icon. Legacy Vite web client is now at
// /legacy (see below).
// Lists every version of OpenChat (iOS TestFlight, Android APK, Mobile Web,
// Desktop Web) so we have one shareable URL that branches to all platforms.
// Must be registered BEFORE express.static(clientDistPath) below so it
// takes precedence over any /about path the Vite client might claim.
const landingHtmlPath = path.join(__dirname, 'landing.html');
const landingIconPath = path.join(__dirname, 'landing-icon.png');
const landingQrPath = path.join(__dirname, 'qr-chat-globalbrai.svg');
app.get(['/', '/about'], (_req, res) => {
  res.sendFile(landingHtmlPath);
});
app.get('/about/icon.png', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(landingIconPath);
});
// Shareable QR for chat.globalbr.ai (OpenChat-84u). Static SVG generated
// once at build time; cache long since the URL it encodes never changes.
app.get('/about/qr.svg', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(landingQrPath);
});

// Per-user "add me" landing page (OpenChat-qr-onboard). Reached when a
// non-installed user scans a personal QR (encoded as
// https://chat.globalbr.ai/u/<userId>). Renders a small SSR page that
// requires no JS to show the inviter's name + a clear sign-in / install
// CTA carrying the intent forward via ?intent=add-user&id=<id>.
//
// Once Associated Domains (OpenChat-84u.2) is enabled, installed-app
// users skip this page entirely — iOS opens OpenChat directly. This
// page is the no-app fallback.
app.get('/u/:userId', async (req, res, next) => {
  const userId = req.params.userId as string;
  if (!userId || userId.length < 4 || userId.length > 32) return next();
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})
       RETURN u { .id, .name, .email, .avatarUrl, .isBot } AS user LIMIT 1`,
      { userId }
    );
    if (result.records.length === 0) return next();
    const user = result.records[0].get('user') as {
      id: string; name?: string | null; email: string;
      avatarUrl?: string | null; isBot?: boolean | null;
    };
    const displayName = (user.name || user.email.split('@')[0] || 'OpenChat user');
    const initial = (displayName[0] || '?').toUpperCase();
    const intentQs = `?intent=add-user&id=${encodeURIComponent(userId)}`;
    const safe = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#5664e2">
<title>${safe(displayName)} on OpenChat</title>
<meta name="description" content="${safe(displayName)} wants to add you on OpenChat.">
<meta property="og:title" content="${safe(displayName)} on OpenChat">
<meta property="og:description" content="${safe(displayName)} wants to add you on OpenChat. Tap to start a conversation.">
<style>
  :root { --bg:#0a0c18; --surface:rgba(255,255,255,0.05); --border:rgba(255,255,255,0.10);
          --text:#f4f6ff; --text-dim:#9aa0c5; --accent:#7c80ff; --accent-bg:linear-gradient(135deg,#4f57e8 0%,#8a4cd8 100%); }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased;
              font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; line-height:1.5; }
  body::before { content:""; position:fixed; inset:0; z-index:-1;
    background:
      radial-gradient(700px 500px at 20% -10%,#2a2475 0%,transparent 60%),
      radial-gradient(600px 500px at 80% 110%,#6230a8 0%,transparent 55%),
      var(--bg); }
  .wrap { max-width:480px; margin:0 auto; padding:48px 24px; text-align:center; }
  .avatar { width:96px; height:96px; border-radius:50%; margin:0 auto 20px;
            background:var(--accent-bg); color:#fff; font-size:42px; font-weight:700;
            display:flex; align-items:center; justify-content:center;
            box-shadow:0 14px 30px rgba(124,128,255,0.35); }
  .name { font-size:24px; font-weight:700; margin:0 0 4px; letter-spacing:-0.01em; }
  .invite { color:var(--text-dim); font-size:15px; margin:0 0 32px; }
  .cta { display:block; padding:14px 22px; margin:10px 0; border-radius:12px;
         font-weight:600; font-size:15px; text-decoration:none; }
  .cta-primary { background:var(--accent-bg); color:#fff;
                 box-shadow:0 8px 20px rgba(124,128,255,0.4); }
  .cta-secondary { background:var(--surface); color:var(--text); border:1px solid var(--border); }
  .cta-tiny { font-size:13px; color:var(--text-dim); padding:8px; }
  .cta-tiny a { color:var(--accent); text-decoration:underline; }
  .footer { font-size:11px; color:var(--text-dim); margin-top:30px; }
  .footer a { color:var(--text-dim); }
</style>
</head><body>
<div class="wrap">
  ${user.avatarUrl
    ? `<img class="avatar" style="object-fit:cover" src="${safe(user.avatarUrl)}" alt="${safe(displayName)}">`
    : `<div class="avatar">${safe(initial)}</div>`}
  <h1 class="name">${safe(displayName)}${user.isBot ? ' <span style="font-size:13px;color:var(--text-dim)">· bot</span>' : ''}</h1>
  <p class="invite">wants to connect on OpenChat — tap below to start.</p>

  <a class="cta cta-primary" href="/m/${intentQs}">Open in mobile web · sign in</a>
  <a class="cta cta-secondary" href="/d/${intentQs}">Open on desktop web</a>
  <a class="cta cta-secondary" href="https://testflight.apple.com/join/QvUPzDMY">Get the iOS app · TestFlight</a>

  <p class="cta-tiny">Already have OpenChat? <a href="openchat://user/${encodeURIComponent(userId)}">Open the app directly</a></p>

  <div class="footer">
    <a href="/">chat.globalbr.ai</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a>
  </div>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(html);
  } catch (err) {
    console.error('/u/:userId render error:', err);
    next();
  } finally {
    await session.close();
  }
});

// Apple App Site Association (OpenChat-84u.1). Enables Universal Links so
// tapping https://chat.globalbr.ai/i/<token> or .../u/<id> in Messages /
// Mail / Safari opens the native OpenChat app when installed, instead of
// landing in mobile Safari. Apple fetches this file once when the app is
// installed and caches it.
//
// MUST be served:
//   - at /.well-known/apple-app-site-association (no extension in URL)
//   - with Content-Type: application/json
//   - over HTTPS (we're behind Cloudflare → nginx, so this is fine)
//   - without redirects
const aasaPath = path.join(__dirname, 'well-known', 'apple-app-site-association.json');
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(aasaPath);
});

// /about/connect-your-bot — agent integration guide (OpenChat-7c9).
// Rendered once at startup from docs/connect-your-bot.md so updates only need
// a redeploy, not new route code. Wrapped in the same dark-violet shell as
// the landing page for visual continuity.
const connectBotMdPath = path.join(__dirname, 'docs', 'connect-your-bot.md');
let connectBotHtmlCache: string | null = null;
function renderConnectBotHtml(): string {
  if (connectBotHtmlCache) return connectBotHtmlCache;
  let body = '';
  try {
    const md = readFileSync(connectBotMdPath, 'utf8');
    body = marked.parse(md, { async: false }) as string;
  } catch (e) {
    body = `<p>Failed to load docs: ${(e as Error).message}</p>`;
  }
  connectBotHtmlCache = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#5664e2">
<title>Connect your agent — OpenChat</title>
<meta name="description" content="Set up bi-directional MCP access to OpenChat. Claude Desktop, Cursor, Codex CLI, Claude Code — all supported via one config snippet.">
<style>
  :root { --bg:#0a0c18; --surface:rgba(255,255,255,0.04); --border:rgba(255,255,255,0.10);
          --text:#f4f6ff; --text-dim:#9aa0c5; --accent:#7c80ff; --accent-2:#ad6cff;
          --code-bg:#0f1230; --code-border:rgba(255,255,255,0.08); }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--bg); color:var(--text);
              font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
              -webkit-font-smoothing:antialiased; line-height:1.6; }
  body::before { content:""; position:fixed; inset:0; z-index:-1;
    background:
      radial-gradient(900px 600px at 20% -10%,#2a2475 0%,transparent 60%),
      radial-gradient(800px 500px at 80% 10%,#6230a8 0%,transparent 55%),
      var(--bg); }
  .wrap { max-width:780px; margin:0 auto; padding:24px; }
  .nav { padding:16px 0 32px; display:flex; align-items:center; gap:12px; }
  .nav img { width:32px; height:32px; border-radius:8px; }
  .nav a { color:var(--text-dim); text-decoration:none; font-weight:500; font-size:14px; }
  .nav a:hover { color:var(--text); }
  .nav .sep { color:var(--text-dim); opacity:0.4; }
  .doc { padding:8px 0 64px; }
  h1 { font-size:clamp(28px,4vw,40px); letter-spacing:-0.02em; margin:0 0 24px;
       background:linear-gradient(180deg,#fff 0%,#c8cbff 130%);
       -webkit-background-clip:text; background-clip:text; color:transparent; }
  h2 { font-size:22px; margin:36px 0 12px; letter-spacing:-0.01em; color:var(--text); }
  h3 { font-size:18px; margin:28px 0 10px; color:var(--text); }
  h4 { font-size:15px; margin:18px 0 8px; color:var(--text-dim); }
  p, li { color:var(--text); }
  a { color:var(--accent); }
  a:hover { color:#b9bcff; }
  hr { border:none; border-top:1px solid var(--border); margin:36px 0; }
  code { background:var(--code-bg); padding:2px 6px; border-radius:5px;
         font-size:0.9em; border:1px solid var(--code-border);
         font-family:"SF Mono",Menlo,Consolas,monospace; }
  pre { background:var(--code-bg); padding:16px 18px; border-radius:10px;
        border:1px solid var(--code-border); overflow-x:auto; margin:16px 0;
        font-size:13px; line-height:1.5; }
  pre code { background:transparent; padding:0; border:none; font-size:13px; }
  table { width:100%; border-collapse:collapse; margin:16px 0; font-size:14px; }
  th, td { padding:10px 14px; border-bottom:1px solid var(--border); text-align:left; }
  th { color:var(--text-dim); font-weight:600; font-size:12px; letter-spacing:0.05em; text-transform:uppercase; }
  blockquote { margin:16px 0; padding:12px 16px; border-left:3px solid var(--accent);
               background:var(--surface); border-radius:0 8px 8px 0; color:var(--text-dim); }
  ul, ol { padding-left:24px; }
  li { margin:6px 0; }
</style>
</head><body>
<div class="wrap">
  <nav class="nav">
    <a href="/about"><img src="/about/icon.png" alt="OpenChat"></a>
    <a href="/about">Home</a>
    <span class="sep">·</span>
    <a href="/about/connect-your-bot">Connect your agent</a>
    <span class="sep">·</span>
    <a href="https://github.com/tmad4000/openchat-mcp-server" target="_blank" rel="noopener">MCP Server</a>
  </nav>
  <article class="doc">
${body}
  </article>
</div>
</body></html>`;
  return connectBotHtmlCache;
}
app.get('/about/connect-your-bot', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('html').send(renderConnectBotHtml());
});

// Serve static files from client build (production).
// This is the LEGACY Vite/React web client. The canonical new clients are
// /m (RN-web mobile) and /d (RN-web desktop). We keep the legacy client
// reachable at every path it used to claim (for bookmarks + the /i/<token>
// group-invite deep link), but the discoverable entry point is now /legacy.
const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// /legacy — official entry point to the legacy Vite web client.
// Injects a small "deprecated" banner across the top of the SPA shell so
// users know the new app is at /m, /d, or the home page. The SPA still
// runs underneath; React Router takes over for sub-routes.
let legacyShellCache: string | null = null;
function getLegacyShell(): string {
  if (legacyShellCache) return legacyShellCache;
  try {
    const html = readFileSync(path.join(clientDistPath, 'index.html'), 'utf8');
    const banner = `<div id="oc-legacy-banner" style="position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#4f57e8 0%,#8a4cd8 100%);color:#fff;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;box-shadow:0 2px 12px rgba(0,0,0,0.25);"><span>You're on the legacy OpenChat web client.</span><a href="/" style="color:#fff;text-decoration:underline;font-weight:700;">Go to the new app →</a></div><style>body{padding-top:42px !important;}</style>`;
    legacyShellCache = html.replace('<body>', `<body>${banner}`);
    return legacyShellCache;
  } catch {
    // If the legacy build is missing, fall back to a tiny placeholder
    // that just links to the new app.
    return `<!doctype html><html><body><p>The legacy web client is not built. <a href="/">Go to OpenChat</a>.</p></body></html>`;
  }
}
app.get(/^\/legacy(\/|$)/, (_req, res) => {
  res.type('html').send(getLegacyShell());
});

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
app.use('/api/agent-keys', agentKeysRoutes);

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

// Error notifier (must come AFTER the SPA fallback, BEFORE any final
// app.use). Pushes 5xx errors to Slack via SLACK_ERROR_WEBHOOK_URL with
// in-memory rate limiting so a tight loop can't flood the channel.
// Wrapping this around an error-middleware signature (4 args) means it
// only catches errors that are `next(err)`'d — non-error normal traffic
// flows through untouched. See server/src/services/errorNotifier.ts.
import { errorNotifierMiddleware } from './services/errorNotifier.js';
app.use(errorNotifierMiddleware);

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
