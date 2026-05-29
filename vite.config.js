import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.VITE_API_PORT || 5000;

export default defineConfig({
  plugins: [react()],
  // En dev: proxy /api → Express
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        ws: true,        // proxy WebSocket too (SSE arbitrage stream)
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Warn if any chunk > 1MB
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'chart-vendor': ['recharts', 'lightweight-charts'],
        },
      },
    },
  },
});
