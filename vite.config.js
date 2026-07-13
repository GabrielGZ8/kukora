import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,

    // ── Dev proxy — forwards all /api/* requests to the Express server ────
    // Without this file, Vite has no proxy config and every /api call hits
    // the Vite dev server directly, producing ECONNREFUSED errors because
    // the Express process is listening on :5000, not :5173.
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        // Don't rewrite — Express mounts all routes under /api already.
        // Increase timeout so slow arbitrage/forecast endpoints (up to 30s)
        // don't get cut off by Vite's default 30s proxy timeout.
        proxyTimeout: 45000,
        timeout: 45000,
        // Retry the proxy on ECONNREFUSED so a slow server startup doesn't
        // cause permanent 502s for the first few seconds after `npm run dev`.
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            // Only log once per error type to keep the console clean during
            // the brief window when the server is still booting.
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: false,
                error: 'API server not ready — retrying shortly.',
                code: 'SERVER_STARTING',
              }));
            }
          });
        },
      },
    },

    // ── COOP header for Firebase Google Sign-In ───────────────────────────
    // Firebase's signInWithPopup polls `window.closed` on the OAuth popup
    // it opens. The browser blocks that cross-origin handle access when
    // Cross-Origin-Opener-Policy is "same-origin" (Helmet's default).
    // "same-origin-allow-popups" preserves COOP protections for all other
    // windows while explicitly allowing the popup opened by this page.
    // This must be set here (dev server) AND in server/index.js (production)
    // because in dev the HTML is served by Vite, not Express.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
    },
  },

  build: {
    // Raise the warning threshold slightly — the app has legitimate large
    // vendor chunks (recharts, lightweight-charts). Splitting further would
    // add latency with no real benefit for this app's traffic pattern.
    chunkSizeWarningLimit: 1000,

    rollupOptions: {
      output: {
        // Manual chunk splitting keeps the initial bundle lean:
        //   react-vendor: React, React-DOM, React-Router (always needed)
        //   chart-vendor:  charting libs (only needed on chart pages)
        //   everything else: code-split per-page via dynamic import() in App.jsx
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'chart-vendor': ['recharts', 'lightweight-charts'],
        },
      },
    },
  },

  // Ensure Vite resolves .env VITE_* vars correctly
  envPrefix: 'VITE_',
});
