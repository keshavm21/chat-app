import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // In development the page is served here (:5173) and the server runs on :5001. The
  // proxy makes them one origin, as in production, where Express serves the built client.
  // The browser's Origin header passes through unchanged, so CLIENT_URL stays :5173.
  server: {
    proxy: {
      '/api': 'http://localhost:5001',
      '/socket.io': { target: 'http://localhost:5001', ws: true },
    },
  },
})
