import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Deterministic JWT secrets for the whole test run. auth.js is loaded
    // both via ESM `import` (ends up under Vitest's module graph) and via
    // CJS `require()` (some test files intentionally require() it to reach
    // the same mongoose model instances — see the comment in
    // auth.routes.test.js). Without a fixed secret in the environment,
    // auth.js's `crypto.randomBytes(64).toString('hex')` fallback can
    // produce two different secrets across those two module instances,
    // which makes any test that signs a token in one instance and verifies
    // it in the other fail with "invalid signature" — not a real auth bug,
    // just test-environment nondeterminism.
    env: {
      JWT_SECRET: 'test-jwt-secret-do-not-use-in-prod-0000000000000000',
      JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-do-not-use-in-prod-0000000',
    },
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js', 'tests/**/*.test.jsx'],
    exclude: ['tests/smoke.test.js', 'tests/v17.test.js', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['server/**/*.js'],
      exclude: [
        'server/index.js',       // Express wiring, tested via integration
        'server/models.js',      // Mongoose schema definitions
        'node_modules/**',
      ],
      // Issue 33 / M-6: Coverage thresholds — raised progressively as test
      // coverage grows, siempre midiendo con --coverage ANTES de subir el
      // número (nunca al valor exacto medido, para no romper con la
      // fluctuación normal entre runs).
      // Sesión 24 coverage (real, medido tras cerrar crypto.service.js de
      // 16% a 91.02% y spreadHeatmapService.js de 18% a cobertura parcial
      // de sus rutas en memoria — ver tests/cryptoService.test.js y
      // tests/spreadHeatmapService.test.js):
      // statements 68.04% / branches 57.26% / functions 66.45% / lines 71.2%.
      // (Columnas del reporte v8: % Stmts | % Branch | % Funcs | % Lines —
      // ojo con el orden al leer la tabla de `npm run test:coverage`.)
      // Remaining big gaps: exchangeService.js (47%, connectX()/init()
      // cubierto, scheduleReconnect()/closeAll() con cobertura parcial),
      // spreadHeatmapService.js (rama "Mongo listo" de flush()/getHeatmap()
      // sin cubrir — se investigó y se descartó por esta sesión: los tests
      // candidatos tardaban ~10s c/u, sospechoso de tocar el driver real de
      // Mongoose en vez del mock global; queda como item propio, ver
      // tests/spreadHeatmapService.test.js), liveInventoryReconciliation.js/
      // replayService.js (55-60%). Target de largo plazo sin cambios:
      // lines:75 / functions:70 / branches:65 / statements:75.
      thresholds: {
        lines:      70,
        functions:  65,
        branches:   56,
        statements: 67,
      },
    },
    // Mock mongoose globally so server modules can be imported without a DB
    setupFiles: ['./tests/setup.js', './tests/setupJsdom.js'],
  },
});
