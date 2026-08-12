import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Le front parle à l'API du serveur Fastify en dev.
    proxy: { '/api': 'http://localhost:3000' },
  },
})
