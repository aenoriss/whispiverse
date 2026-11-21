import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the client is served by Vite and talks to the server on 4100 through
// this proxy, so both the page and the socket are on one origin, as they are in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/socket.io': { target: 'http://localhost:4100', ws: true },
      '/health': 'http://localhost:4100',
    },
  },
})
