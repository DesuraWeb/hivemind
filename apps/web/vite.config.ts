import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// orb.js (vendor, copié tel quel depuis docs/design/ — jamais modifié, cf.
// CLAUDE.md) importe three.js depuis un CDN en dur : c'est ainsi que le
// prototype .dc.html le charge, mais un bundle de prod ne doit pas dépendre
// d'un réseau externe au runtime. L'alias réécrit cette URL exacte vers le
// `three` installé localement (apps/web/package.json) — orb.js reste
// intouché, seule la résolution d'import change.
const ORB_THREE_CDN_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { [ORB_THREE_CDN_URL]: 'three' },
  },
  server: {
    port: 5173,
    // Le front parle à l'API du serveur Fastify en dev.
    proxy: { '/api': 'http://localhost:3000' },
  },
})
