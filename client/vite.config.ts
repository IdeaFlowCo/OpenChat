import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const clientPort = parseInt(process.env.VITE_PORT || '29231', 10);
const serverPort = parseInt(process.env.VITE_SERVER_PORT || '41851', 10);
const serverTarget = process.env.VITE_SERVER_URL || `http://localhost:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: clientPort,
    strictPort: true,
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
