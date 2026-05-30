import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.VITE_API_PORT || 5000;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        ws: true,
        // Timeout for SSE connections (0 = no timeout)
        timeout: 0,
        configure: (proxy) => {
          proxy.on('error', (err, _req, _res) => {
            // Suppress noisy proxy errors during server startup
            if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
              console.error('[proxy]', err.message);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'chart-vendor': ['recharts', 'lightweight-charts'],
        },
      },
    },
  },
});
