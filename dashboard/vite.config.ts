import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Proxy keeps the dashboard origin-relative, so the same build works
    // against localhost in dev and a laptop IP at the demo table.
    proxy: {
      // NaTrack's API (/v1, /session) and everything it does not cover (/api).
      '/v1': 'http://localhost:8000',
      '/api': 'http://localhost:8000',
      '/session': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
