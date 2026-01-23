import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    env[key] = value;
  }
  return env;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function randomPort() {
  return 20000 + Math.floor(Math.random() * 40000);
}

async function findFreePort(preferred, exclude = new Set()) {
  if (!exclude.has(preferred) && await isPortFree(preferred)) {
    return { port: preferred, changed: false };
  }

  for (let i = 0; i < 50; i += 1) {
    const candidate = randomPort();
    if (exclude.has(candidate)) continue;
    if (await isPortFree(candidate)) {
      return { port: candidate, changed: true };
    }
  }

  throw new Error('Unable to find a free port.');
}

async function start() {
  const serverEnvFile = parseEnvFile(path.join(repoRoot, 'server', '.env'));
  const defaultServerPort = parsePort(
    process.env.OPENCHAT_SERVER_PORT || process.env.PORT || serverEnvFile.PORT,
    41851
  );
  const defaultClientPort = parsePort(
    process.env.OPENCHAT_CLIENT_PORT || process.env.VITE_PORT,
    29231
  );
  const noosUrl = process.env.VITE_NOOS_URL || process.env.NOOS_URL || serverEnvFile.NOOS_URL || 'http://localhost:52743';

  const serverResult = await findFreePort(defaultServerPort);
  const clientResult = await findFreePort(defaultClientPort, new Set([serverResult.port]));

  if (serverResult.changed) {
    console.warn(`[openchat] Port ${defaultServerPort} in use, using ${serverResult.port} for server.`);
  }
  if (clientResult.changed) {
    console.warn(`[openchat] Port ${defaultClientPort} in use, using ${clientResult.port} for client.`);
  }

  const clientUrl = `http://localhost:${clientResult.port}`;

  const serverEnv = {
    ...serverEnvFile,
    ...process.env,
    PORT: String(serverResult.port),
    CORS_ORIGIN: clientUrl,
    NOOS_URL: noosUrl,
    OPENCHAT_URL: clientUrl,
  };

  const clientEnv = {
    ...process.env,
    VITE_PORT: String(clientResult.port),
    VITE_SERVER_PORT: String(serverResult.port),
    VITE_NOOS_URL: noosUrl,
  };

  const serverProc = spawn('npm', ['run', 'dev', '--workspace=server'], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: 'inherit',
  });

  const clientProc = spawn('npm', ['run', 'dev', '--workspace=client'], {
    cwd: repoRoot,
    env: clientEnv,
    stdio: 'inherit',
  });

  const shutdown = (code) => {
    serverProc.kill('SIGTERM');
    clientProc.kill('SIGTERM');
    process.exit(code ?? 0);
  };

  serverProc.on('exit', (code) => shutdown(code ?? 0));
  clientProc.on('exit', (code) => shutdown(code ?? 0));

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

start().catch((error) => {
  console.error('[openchat] Failed to start dev servers:', error);
  process.exit(1);
});
