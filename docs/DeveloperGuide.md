# Kukora — Developer Guide

## Prerequisites

- **Node.js** ≥ 18 (v20 LTS recommended)
- **npm** ≥ 9
- **MongoDB Atlas** URI — optional; runs fully in-memory without it

---

## Quick Start

```bash
git clone https://github.com/GabrielGZ8/kukora.git
cd kukora

# Install all dependencies (including dev)
npm install

# Copy environment template and configure
cp .env.example .env
# Edit .env — at minimum, MONGODB_URI is optional (in-memory mode works fine)

# Start both servers in dev mode (hot reload on server changes)
npm run dev:watch
```

The API server starts on `:5000` and the Vite dev server on `:5173`.
The frontend proxies all `/api` and `/health` requests to the backend.

---

## Environment Variables

See `.env.example` for the complete list with documentation.

| Variable       | Required | Default       | Description |
|----------------|----------|---------------|-------------|
| `PORT`         | No       | `5000`        | API server port |
| `NODE_ENV`     | No       | `development` | `development` \| `production` \| `test` |
| `MONGODB_URI`  | No       | —             | Atlas connection string. Without it, state resets on restart. |
| `FRONTEND_URL` | No       | —             | CORS origin for production deploys |
| `LOG_LEVEL`    | No       | `info`        | `debug` \| `info` \| `warn` \| `error` |
| `DEMO_MODE`    | No       | `false`       | Load sandbox engine instead of live engine |

---

## Development Commands

```bash
npm run dev          # Concurrent server + vite (no hot reload on server)
npm run dev:watch    # Concurrent server + vite with --watch on server/
npm run build        # Production Vite build to dist/
npm run start        # Production — serves API + built static files

npm test             # Run test suite (Vitest)
npm run test:watch   # Vitest in watch mode
npm run test:coverage# Coverage report (60% gate)
npm run test:smoke   # Smoke tests against running server

npm run lint         # ESLint across src/ and server/
npm run lint:fix     # Auto-fix lint issues
npm run audit        # npm audit --audit-level=high

npm run docker:build # Build Docker image
npm run docker:run   # Run containerized
```

---

## Project Structure

> Actualizado 2026-07-08. La estructura de `server/` cambió de un directorio
> plano a bounded contexts explícitos (`domain/`, `infrastructure/`,
> `application/`, `repositories/`, `routes/`) — ver ADR-011, ADR-012,
> `MIGRATION_CLEANUP_LOG.md`. Este árbol refleja el layout real, no el
> histórico. Solo `index.js` y `models.js` quedan sueltos en la raíz de
> `server/` (ver ADR-010 sobre por qué `models.js` no vive en
> `infrastructure/persistence/`).

```
kukora/
├── server/                          # Node.js backend
│   ├── index.js                     # Express app, middleware, startup
│   ├── models.js                    # User/Alert/Watchlist/Portfolio/Notification (ADR-010)
│   ├── exchangeAdapter.js           # Shared exchange client shape
│   │
│   ├── domain/                      # Reglas de negocio puras (47 módulos)
│   │   ├── errors.js                # Jerarquía DomainError + expressErrorHandler
│   │   ├── opportunity.js           # Tipo Opportunity compartido (TS)
│   │   ├── validation.js            # Validación genérica (alerts/watchlist/portfolio)
│   │   ├── risk/                    # Circuit breakers, exposure, validaciones de riesgo (8)
│   │   │   ├── advancedRiskEngine.js
│   │   │   ├── slippageValidator.js
│   │   │   └── ...
│   │   ├── wallet/                  # Balances, fees, P&L (5)
│   │   │   ├── walletManager.js     # Pre-funded bilateral balances
│   │   │   ├── feeConfig.js
│   │   │   └── ...
│   │   ├── engines/                 # Detección, backtesting, scoring, rebalanceo (17)
│   │   │   ├── opportunityDetection.js  # Detección + scoring VWAP L2 (ex arbitrageEngine.js)
│   │   │   ├── multiHopArbitrageEngine.js
│   │   │   ├── statArbEngine.js
│   │   │   ├── mlScoringPipeline.js # Composite scoring, model registry
│   │   │   └── ...
│   │   └── analytics/               # Indicadores, forecasting, lifecycle, journal (14)
│   │       ├── analytics.js
│   │       ├── tradeStateMachine.js # 12-state FSM, rollback, audit
│   │       └── ...
│   │                                 # ver `find server/domain -name '*.js'` para la lista completa.
│   │                                 # Subcarpetas agregadas en la auditoría de comité 2026-07-08,
│   │                                 # ítem 3 de la hoja de ruta — mismo movimiento que ya se hizo
│   │                                 # una vez a nivel server/, repetido un nivel más adentro.
│   │
│   ├── application/                 # Orquestación / casos de uso (5 módulos)
│   │   ├── arbitrageOrchestrator.js # Loop WS event-driven + poll 150ms (ex arbitrage.engine.js)
│   │   ├── arbitrage.state.js       # Shared mutable state (singleton)
│   │   ├── liveExecution.js         # Ejecución real gateada por 2FA (modo `live`)
│   │   └── liveInventoryReconciliation.js
│   │
│   ├── infrastructure/              # I/O, terceros, cross-cutting (44 módulos)
│   │   ├── exchangeService.js       # WebSocket feeds, order books
│   │   ├── exchangeRegistry.js      # Plugin registry de exchanges
│   │   ├── observabilityService.js  # Structured event emission
│   │   ├── logger.js                # Structured logging (JSON in prod)
│   │   ├── liveConfig.js            # Hot-reloadable parameters
│   │   ├── auth.js                  # JWT + bcrypt + refresh rotation
│   │   └── ...                      # ver `ls server/infrastructure/`
│   │
│   ├── repositories/                # Capa de acceso a datos (audit Level 3 #3)
│   │   └── index.js                 # Repos + MockRepository para tests
│   │
│   ├── routes/                      # Endpoints HTTP top-level
│   │   ├── crypto.routes.js
│   │   ├── trading.routes.js
│   │   └── ...
│   │
│   └── arbitrage/                   # Namespace de /api/arbitrage/*
│       ├── index.js
│       └── subroutes/               # query.routes.js, config.routes.js, stream.routes.js
│
├── src/                      # React frontend
│   ├── App.jsx               # Routes, lazy loading
│   ├── api.js                # API client
│   ├── main.jsx              # Vite entry point
│   ├── components/
│   │   ├── layout/Layout.jsx # Sidebar nav, topbar, theme
│   │   └── common/           # Shared panels and widgets
│   ├── pages/                # One file per route
│   ├── hooks/                # Custom React hooks
│   ├── utils/                # Pure utility functions
│   └── styles/global.css     # Design tokens + global styles
│
├── docs/                     # ADRs, architecture, guides
├── tests/                    # Vitest unit tests + smoke tests
├── .github/workflows/ci.yml  # CI pipeline
├── Dockerfile                # Two-stage Alpine build
├── .env.example              # Environment template
└── package.json
```

---

## Adding a New Server Module

1. Decide which bounded context it belongs to first: pure business rule →
   `server/domain/myModule.js`; orchestration/use-case → `server/application/`;
   I/O, third-party, or cross-cutting concern → `server/infrastructure/`.
   Export named functions, no default exports in Node modules.
2. Use `require('../infrastructure/liveConfig')` for any tuneable thresholds.
3. Emit structured events via `require('../infrastructure/observabilityService').emit(...)`.
4. Add an import in `server/index.js` or the relevant `routes/` file.
5. Write a dedicated `tests/myModule.test.js` — do not append to a shared
   catch-all test file. See "Tests" section below on why the `getHandler()`
   pattern is discouraged for route tests.

---

## Adding a New Frontend Page

1. Create `src/pages/MyPage.jsx`.
2. Add a lazy import in `App.jsx` following the existing pattern.
3. Add a `<Route>` entry in the `<Routes>` block.
4. Add a nav entry to the `NAV` array in `Layout.jsx` with the appropriate group.
5. Use `usePolling()` for periodic data fetching, `useArbitrageStream()` for SSE.

---

## Logging

The server uses a structured logger (`server/infrastructure/logger.js`).

```js
const { logger } = require('./logger');

// All calls follow: logger.level(module, message, meta?)
logger.info('myModule', 'Something happened', { key: 'value', count: 42 });
logger.error('myModule', 'Something failed', { err: error.message });
```

In development, output is human-readable with colour. In production (`NODE_ENV=production`),
each call emits a newline-delimited JSON line — compatible with Datadog, Railway log drain,
and CloudWatch.

---

## Testing

Tests live in `tests/`. The suite uses Vitest and covers:

- `kukora.test.js` — unit tests for scoring, risk, and state machine logic
- `v17.test.js` — integration tests for analytics and backtest engines
- `smoke.test.js` — smoke tests that require a running server (run with `npm run test:smoke`)

Coverage gate is 60% overall. Run `npm run test:coverage` to see the full report.

---

## Deployment

### Railway (recommended)

```bash
# Push to main — Railway auto-deploys using railway.json
# (build/start commands, health check path, and restart policy)
git push origin main
```

Set `MONGODB_URI`, `FRONTEND_URL`, and `NODE_ENV=production` in the Railway environment.

### Docker

```bash
npm run docker:build
npm run docker:run
```

The image uses a two-stage Alpine build and weighs ~180MB. The `HEALTHCHECK` hits `/health`
every 30 seconds with a 10-second timeout.

### Manual

```bash
npm run build
NODE_ENV=production npm run start
```

---

## Demo / Sandbox Mode

Set `DEMO_MODE=true` to load `sandboxEngine.js` instead of the live arbitrage engine.
Sandbox opportunities are synthetic — no real market data is used. This is safe for demos
and UI development.

⚠️  Never set `DEMO_MODE=true` in a live-capital environment.
