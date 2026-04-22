import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit()],
  server: { 
    allowedHosts: ['andrews-macbook-pro-2.taila47af.ts.net'],
    host: true,
    port: 5173,
    proxy: {
      // Same-origin API for remote devices (Tailscale, LAN, etc.)
      '/api': {
        target: process.env.VITE_QUERY_PROXY_TARGET ?? 'http://127.0.0.1:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
   },
})
