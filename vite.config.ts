import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// Camera access requires a secure context. `localhost` is treated as secure, but
// to test on a real phone over the LAN you need HTTPS: run `npm run dev:https`.
const useHttps = process.env.VITE_HTTPS === '1'

export default defineConfig({
  plugins: [
    react(),
    ...(useHttps ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      // Precache the app + the ~5.7MB pose model. The MediaPipe .wasm runtimes are
      // ~11MB each and only ONE variant is used per device, so we runtime-cache the
      // one actually fetched (CacheFirst) instead of precaching all three.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,task}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/mediapipe\//],
        runtimeCaching: [
          {
            urlPattern: /\/mediapipe\/wasm\/.*\.(?:wasm|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe-wasm',
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png', 'pwa-512-maskable.png'],
      manifest: {
        name: 'Lift Stats',
        short_name: 'Lift Stats',
        description: 'Camera-based barbell & bodyweight lift tracker',
        theme_color: '#0b0f17',
        background_color: '#0b0f17',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  server: {
    host: true,
  },
})
