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
        // Timeout 0 = sin límite para SSE (stream infinito)
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            // Suprimir errores de arranque (servidor aún no listo)
            if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return;
            console.error('[proxy]', err.message);
            // Evitar crash si la respuesta ya fue enviada
            if (res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Proxy error: ' + err.message }));
            }
          });
          proxy.on('proxyReq', (_proxyReq, req) => {
            // Marcar SSE para que http-proxy no cierre la conexión
            if (req.url?.includes('stream')) {
              _proxyReq.setHeader('Accept', 'text/event-stream');
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
