import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

function gitValue(command: string): string {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const clientPort = parseInt(process.env.VITE_PORT || '29231', 10);
const serverPort = parseInt(process.env.VITE_SERVER_PORT || '41851', 10);
const serverTarget = process.env.VITE_SERVER_URL || `http://localhost:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __APP_GIT_SHA__: JSON.stringify(gitValue('git rev-parse --short HEAD')),
    __APP_GIT_BRANCH__: JSON.stringify(gitValue('git branch --show-current')),
  },
  server: {
    port: clientPort,
    strictPort: true,
    allowedHosts: ['m3-laptop-server.tailb2a35c.ts.net'],
    proxy: {
      '/api': {
        target: serverTarget,
        changeOrigin: true
      },
      '/socket.io': {
        target: serverTarget,
        ws: true
      }
    }
  }
})
