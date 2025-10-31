import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // proxy для локальной разработки (на проде не используется)
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false
      },
      '/health': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false
      }
    }
  }
})


