import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './vite.pdfjs-assets'
import { VitePWA } from 'vite-plugin-pwa'
import { version } from './package.json'

const pwa = VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src/offline',
  filename: 'sw.ts',
  injectRegister: false, // src/offline/register.ts owns registration and the update flow
  includeManifestIcons: false,
  injectManifest: {
    globPatterns: ['index.html', 'boot.js', 'icon.svg', '*.png', 'assets/*.{js,mjs,css,woff2}', 'pdfjs/{wasm,iccs,standard_fonts}/*'],
    maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
  },
  manifest: {
    id: '/',
    name: 'Shelf',
    short_name: 'Shelf',
    description: 'A private library and reader for manga and light novels.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'any',
    background_color: '#0b0c0e',
    theme_color: '#0b0c0e',
    categories: ['books', 'entertainment'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
})

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), pdfjsAssets(), pwa],
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_PROXY ?? 'http://localhost:8000', changeOrigin: true } },
  },
})
