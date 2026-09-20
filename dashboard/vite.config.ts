import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

// With the backend down Vite's proxy answers a bare 500, which reads as "the
// server had a problem" beside a masthead that says it is unreachable. Say what
// happened: 502, which src/lib/api.ts words as "Can't reach the server".
const honest = (target: string): ProxyOptions => ({
  target,
  configure: (proxy) => {
    proxy.on('error', (_err, _req, res) => {
      // For a WebSocket upgrade `res` is a socket, and closing is all there is.
      if ('writeHead' in res) {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      }
    })
  },
})

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Proxy keeps the dashboard origin-relative, so the same build works
    // against localhost in dev and a laptop IP at the demo table.
    proxy: {
      // NaTrack's API (/v1, /session) and everything it does not cover (/api).
      '/v1': honest('http://localhost:8000'),
      '/api': honest('http://localhost:8000'),
      '/session': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
