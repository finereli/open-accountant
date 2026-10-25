import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { buildNumber, pwaOptions } from './shared/build/pwa-build'

const MAJOR = 1

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(buildNumber(MAJOR)),
  },
  resolve: {
    alias: { $shared: fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  plugins: [
    svelte(),
    VitePWA(
      pwaOptions({
        includeAssets: ['icons/*.png'],
        // The MCP's OAuth pages and discovery are server pages, never the app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/icons\//, /^\/fonts\//, /^\/reset(\.html)?$/, /^\/oauth\//, /^\/mcp$/, /^\/\.well-known\//, /^\/cdn-cgi\//],
        manifest: {
          name: 'Accountant',
          short_name: 'Accountant',
          description: 'Ledgers you can trust, a spending view and a cash forecast',
          lang: 'en',
          dir: 'ltr',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#f4f7f6',
          theme_color: '#0c4a4f',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      })
    ),
  ],
})
