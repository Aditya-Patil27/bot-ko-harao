import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/join': 'http://localhost:3001',
      '/clue': 'http://localhost:3001',
      '/guess': 'http://localhost:3001',
      '/rpc': 'http://localhost:3001',
      '/state': 'http://localhost:3001',
      '/start': 'http://localhost:3001',
      '/stat': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
