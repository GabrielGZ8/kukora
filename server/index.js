'use strict';

// MUST be the very first thing that runs: auth.js and firebaseAdmin.js read
// process.env.JWT_SECRET / FIREBASE_PROJECT_ID / etc. at module-load time
// (not inside a function), so .env has to be loaded before those modules
// are required below — otherwise they silently fall back to "unset".
require('dotenv').config();

// OpenTelemetry auto-instrumentation patches http/express/mongodb at
// require() time, so telemetry.init() must run before any of those modules
// are loaded anywhere below. No-op unless OTEL_ENABLED=true (see
// server/infrastructure/telemetry.js for the zero-cost-when-disabled design).
require('./infrastructure/telemetry').init();

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const mongoose     = require('mongoose');
const cookieParser = require('cookie-parser');

const { logger }            = require('./infrastructure/logger');
const metrics               = require('./infrastructure/metricsService');
const { sessionMiddleware } = require('./infrastructure/sessionMiddleware');
const { requestMiddleware } = require('./infrastructure/requestMiddleware');
const cryptoRoutes          = require('./routes/crypto.routes');
const arbitrageRoutes       = require('./routes/arbitrage.routes');
const notificationsRoutes   = require('./routes/notifications.routes');
const tradingRoutes         = require('./routes/trading.routes');
// checkpoint-37: per-user exchange credentials + per-user live-trading
// toggle — see each router's own header comment for the endpoint list.
const userExchangeCredentialsRoutes = require('./routes/userExchangeCredentials.routes');
const userLiveModeRoutes            = require('./routes/userLiveMode.routes');
const { router: authRouter, hybridAuth } = require('./infrastructure/auth');

const app     = express();
app.set('x-powered-by', false);
const PORT    = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Trust the first hop's X-Forwarded-* headers. Kukora is deployed behind a
// platform proxy (Railway — see railway.json; ADR-012/L-4 removed the
// unused render.yaml/vercel.json/Procfile configs), so without this Express
// sees the proxy's IP for every request, not the client's. That silently
// breaks IP-keyed rate limiting
// below: every anonymous client (no session header yet) would share one
// bucket. `1` trusts exactly one hop, which matches a single reverse proxy
// in front of the app — not an open-ended `true`, which would let a client
// spoof X-Forwarded-For directly.
app.set('trust proxy', 1);

// ─── Security headers ────────────────────────────────────────────────────
// Issue 20: Per-request nonce for CSP (removes unsafe-inline)
const crypto = require('crypto');
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: [
        "'self'", 'wss:', 'ws:',
        'https://identitytoolkit.googleapis.com',
        'https://securetoken.googleapis.com',
        'https://www.googleapis.com',
        'https://*.googleapis.com',
      ],
      frameSrc:   ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com'],
    },
  },
  // COOP must be relaxed to allow Firebase's signInWithPopup to communicate
  // with the OAuth popup window via window.closed polling. The default
  // "same-origin" policy blocks cross-origin window handles, causing the
  // "Cross-Origin-Opener-Policy policy would block the window.closed call"
  // warning and making popup sign-in unreliable. "same-origin-allow-popups"
  // is the correct value: it keeps COOP protections for all other windows
  // while explicitly allowing the popup opened by this document.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
  // Security fix (audit Gap 2): explicit referrerPolicy prevents Referer header
  // from leaking internal URLs/paths to third-party services (CoinGecko, Firebase).
  // 'strict-origin-when-cross-origin' sends only the origin (no path/query) to
  // cross-origin destinations, which is the recommended modern default.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ─── CORS ─────────────────────────────────────────────────────────────────
const allowedOrigins = (() => {
  const origins = ['http://localhost:5173', 'http://localhost:3000'];
  if (process.env.FRONTEND_URL) {
    // Issue 32: Only allow http/https URLs — silently skip invalid entries
    process.env.FRONTEND_URL.split(',').forEach(u => {
      const trimmed = u.trim();
      try {
        const parsed = new URL(trimmed);
        if (['http:', 'https:'].includes(parsed.protocol)) origins.push(trimmed);
      } catch { /* invalid URL — skip */ }
    });
  }
  return origins;
})();

app.use(cors({
  origin: (origin, cb) => {
    // Issue 5: Never open wildcard in production — fail closed.
    // server-to-server / Postman have no Origin header → always allowed.
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Session-ID', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' })); // Issue 10: bounded body size
app.use(cookieParser());

// ─── Per-request instrumentation ─────────────────────────────────────────
app.use(sessionMiddleware);
app.use(hybridAuth); // upgrades req.userId to JWT sub when token present
app.use(requestMiddleware);

// ─── Rate limiting ────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.includes('/stream'),
  message: { ok: false, error: 'Too many requests. Please slow down.' },
  // req.userId is always a truthy string ('anonymous' when no session header
  // is sent), so `req.userId || req.ip` never actually fell through to the
  // IP address. That meant every anonymous client — every curl, every
  // healthcheck, every user who hadn't generated a session ID yet — shared
  // a single rate-limit bucket. Key on IP explicitly for anonymous traffic.
  keyGenerator: (req) => (req.userId && req.userId !== 'anonymous') ? req.userId : req.ip,
});
app.use(['/api/', '/api/v1/'], apiLimiter);

// I-6 fix: Granular rate limiting for sensitive financial control endpoints.
// These endpoints change live trading behavior — a bug or attack that floods
// them could change trading mode or engine config hundreds of times per minute.
// 10 req/min is generous for legitimate use but blocks accidental hammering.
const financialControlLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Rate limit exceeded for financial control endpoint. Max 10/min.' },
  keyGenerator: (req) => (req.userId && req.userId !== 'anonymous') ? req.userId : req.ip,
  // BUG FIX (Sesión 2026-07-07, tenant-bot UI follow-up): this limiter is
  // mounted with app.use() on whole path prefixes (e.g. '/api/arbitrage/config',
  // '/api/tenant-bot'), which — with no method filter — was also catching
  // read-only GET requests (GET /api/arbitrage/config, GET /api/tenant-bot/status,
  // GET /api/tenant-bot/config). Any UI panel polling one of those GETs every
  // 5s (LiveConfigPanel already does; the new TenantBotPanel does too) burns
  // through the whole 10/min budget from polling ALONE within ~50s, then a
  // user can't even toggle their bot or save a config change afterward —
  // the mutation they actually care about gets starved by their own
  // read-only polling. The stated intent everywhere this limiter is used
  // ("changes trading mode or engine config", "changes a tenant's own
  // trading state") is explicitly about mutations, so GETs are skipped —
  // POST/PUT/PATCH/DELETE on these routes are completely unaffected.
  skip: (req) => req.method === 'GET',
});
// Applied directly to the most sensitive mutation endpoints below
app.use(['/api/trading/mode', '/api/v1/trading/mode'], financialControlLimiter);
app.use(['/api/arbitrage/config', '/api/v1/arbitrage/config'], financialControlLimiter);
app.use(['/api/arbitrage/reset', '/api/v1/arbitrage/reset'], financialControlLimiter);
// Ronda 21 — Fase 3: 2FA enrollment/verification and live order placement
// are exactly the kind of financial-control endpoints this limiter exists
// for (see comment above).
app.use(['/api/trading/2fa', '/api/v1/trading/2fa'], financialControlLimiter);
app.use(['/api/trading/execute', '/api/v1/trading/execute'], financialControlLimiter);
// ADR-017 follow-up (item 5, security audit): the new tenant-bot mutation
// endpoints (bot on/off, config overrides, risk-guard reset) are the same
// class of "changes trading behavior" endpoint this limiter exists for —
// they were missing it entirely when first added (item 2 of this
// session), same oversight class as I-6 originally fixed for
// /api/trading/mode. Covers all of /api/tenant-bot/* (toggle/config/risk)
// rather than being enumerated per-sub-path, since every route under it
// is a mutation of a single tenant's own trading state.
app.use(['/api/tenant-bot', '/api/v1/tenant-bot'], financialControlLimiter);
// Iniciativa 4 (comparación multi-tenant demo, Judge Report support): las
// mutaciones (/start, /stop, /reset) prenden/apagan el bot real de dos
// tenants sintéticos dentro del mismo loop de ejecución de 150ms — misma
// clase de endpoint financiero que el resto de esta lista. GETs (/status)
// quedan exentos por el mismo `skip` de arriba.
app.use(['/api/tenant-demo', '/api/v1/tenant-demo'], financialControlLimiter);
// checkpoint-37: connecting/disconnecting exchange API keys and toggling
// per-user real-money trading are the same class of financial-control
// endpoint this limiter exists for (see comment above). GETs are skipped
// by the limiter's own `skip` (status/list polling shouldn't burn the
// mutation budget), same as every other entry here.
app.use(['/api/user/exchange-credentials', '/api/v1/user/exchange-credentials'], financialControlLimiter);
app.use(['/api/user/live-mode', '/api/v1/user/live-mode'], financialControlLimiter);

// ─── Database ─────────────────────────────────────────────────────────────
let dbConnected = false;

if (process.env.MONGODB_URI) {
  // Item 5 (Mongo Atlas readiness, post-checkpoint-03): Atlas free/shared
  // tiers can take a few seconds to resume from an idle/paused state, and
  // DNS SRV resolution for `mongodb+srv://` can hiccup transiently on cold
  // boot. Previously a single failed connect() meant "in-memory mode until
  // the process is manually restarted" — this bootRetryConnect() wrapper
  // retries with capped exponential backoff (1s, 2s, 4s, 8s, 16s, then every
  // 30s) WITHOUT blocking server startup (the app already runs fine
  // in-memory while this retries in the background — same fallback
  // philosophy as the M-5 persistence retry queue).
  const MONGO_OPTS = {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    // bufferTimeoutMS fix: without this, Mongoose buffers operations for 10s
    // after a failed connect (5s serverSelectionTimeoutMS). This caused Google
    // sign-in to hang ~37s total. Setting bufferTimeoutMS slightly above the
    // serverSelectionTimeoutMS surfaces DB errors to routes within ~6s.
    bufferTimeoutMS: 6000,
    maxPoolSize: 10,
    // Atlas-recommended defaults (safe no-ops for any other Mongo deployment,
    // e.g. local dev, Railway-hosted Mongo): retryWrites/retryReads already
    // default true on modern Mongoose but are set explicitly here so the
    // intent is visible without having to check the driver's version
    // defaults; w: 'majority' matches Atlas's own connection-string default
    // and avoids silently acknowledging a write before it's replicated.
    retryWrites: true,
    retryReads: true,
    w: 'majority',
  };

  const MONGO_RETRY_BACKOFFS_MS = [1000, 2000, 4000, 8000, 16000]; // then steady 30s
  const MONGO_STEADY_RETRY_MS = 30000;
  let _mongoConnectAttempt = 0;
  let _mongoRetryTimer = null;

  const _onMongoConnected = function _onMongoConnected() {
    dbConnected = true;
    _mongoConnectAttempt = 0;
    if (_mongoRetryTimer) { clearTimeout(_mongoRetryTimer); _mongoRetryTimer = null; }
    logger.info('db', 'MongoDB connected');
    // Auditoría del comité (Sesión 34, P1 #2): al arrancar, cualquier
    // marcador de PendingExecution que haya quedado sin resolver es
    // evidencia directa de que el proceso murió a mitad de una ejecución
    // cross-exchange en la sesión anterior (una pata pudo quedar abierta
    // sin cubrir). El sistema NO intenta adivinar o revertir nada solo —
    // solo loggea una alerta crítica para revisión manual, que es lo
    // correcto cuando el dato es "no sabemos en qué quedó esta pata" y
    // hay dinero real de por medio. No bloquea el arranque.
    const persistenceServiceBoot = require('./infrastructure/persistenceService');
    persistenceServiceBoot.listUnresolvedPendingExecutions()
      .then(orphans => {
        if (orphans.length > 0) {
          logger.error('db', `⚠ ${orphans.length} ejecución(es) cross-exchange sin resolver de una sesión anterior — posible pata abierta sin cubrir, requiere revisión manual`, {
            orphans: orphans.map(o => ({ tradeId: o.tradeId, userId: o.userId, buyExchange: o.buyExchange, sellExchange: o.sellExchange, symbol: o.symbol, amount: o.amount, createdAt: o.createdAt })),
          });
        }
      })
      .catch(e => logger.warn('db', 'checkPendingExecutionsOnBoot failed (non-fatal)', { err: e.message }));
  };

  // Auditoría final (item 7): las 3 declaraciones de función siguientes
  // vivían como `function foo() {}` dentro de este bloque `if` — válido en
  // V8/Node en la práctica, pero `no-inner-declarations` de ESLint lo
  // marca porque el comportamiento de hoisting de function-declarations
  // dentro de bloques no está 100% unificado entre entornos JS (Annex B).
  // Convertidas a `const foo = function()` — mismo comportamiento exacto
  // aquí (ninguna se invoca antes de su propia línea de declaración),
  // cero cambio de runtime, satisface el lint del propio proyecto.
  const _scheduleMongoRetry = function _scheduleMongoRetry() {
    const delay = MONGO_RETRY_BACKOFFS_MS[_mongoConnectAttempt] ?? MONGO_STEADY_RETRY_MS;
    _mongoConnectAttempt++;
    _mongoRetryTimer = setTimeout(bootRetryConnect, delay);
    _mongoRetryTimer.unref?.(); // never keep the process alive just for this
  };

  const bootRetryConnect = function bootRetryConnect() {
    mongoose.connect(process.env.MONGODB_URI, MONGO_OPTS)
      .then(_onMongoConnected)
      .catch(e => {
        logger.warn('db', `MongoDB unavailable (attempt ${_mongoConnectAttempt + 1}) — running in-memory mode, retrying in background`, { err: e.message });
        _scheduleMongoRetry();
      });
  };

  bootRetryConnect();

  // Track disconnect/reconnect so isDbReady() stays accurate at runtime.
  // Mongoose's own driver-level reconnection handles transient drops once
  // the initial connection succeeds — this listener just keeps our flag in
  // sync, it doesn't duplicate reconnection logic.
  mongoose.connection.on('disconnected', () => {
    if (dbConnected) logger.warn('db', 'MongoDB disconnected — switching to in-memory mode');
    dbConnected = false;
  });
  mongoose.connection.on('reconnected', () => {
    dbConnected = true;
    logger.info('db', 'MongoDB reconnected');
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────
// H-9 (Sesión 25): /api/v1/* alias agregado de forma puramente aditiva —
// mismas instancias de router, montadas en 2 prefijos. El frontend (28
// páginas) sigue usando /api/... sin ningún cambio; /api/v1/... queda
// disponible desde ya para integraciones nuevas o consumidores externos
// que quieran depender de un contrato versionado. No se retira ni se
// deprecia /api/... — no hay fecha de corte planeada. Ver
// docs/ADR-015-api-versioning.md para el detalle de la decisión.
app.use(['/api/auth', '/api/v1/auth'],                 authRouter);
app.use(['/api/crypto', '/api/v1/crypto'],               cryptoRoutes);
app.use(['/api/arbitrage', '/api/v1/arbitrage'],           arbitrageRoutes);
app.use(['/api/notifications', '/api/v1/notifications'],      notificationsRoutes);

// ─── Health endpoint ──────────────────────────────────────────────────────
// Returns comprehensive system status for monitoring and load-balancer checks.
const { buildHealthPayload } = require('./infrastructure/healthService');

// ─── Trading routes (C-2) ─────────────────────────────────────────────────
// Extracted from inline app.get/app.post definitions into
// server/routes/trading.routes.js — see that file's header comment for the
// full endpoint list and rationale. financialControlLimiter above still
// applies unchanged (it's registered on the app directly, path-matched
// before this router is reached).
app.use(['/api/trading', '/api/v1/trading'], tradingRoutes);
// checkpoint-37: per-user exchange credentials + per-user live-trading
// toggle — additive, no existing route or behavior changes.
app.use(['/api/user/exchange-credentials', '/api/v1/user/exchange-credentials'], userExchangeCredentialsRoutes);
app.use(['/api/user/live-mode', '/api/v1/user/live-mode'], userLiveModeRoutes);

// Issue 15: Internal endpoints protected by optional INTERNAL_API_KEY
const internalOnly = (req, res, next) => {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return next(); // if not configured, allow (dev mode)
  if (req.headers['x-internal-key'] !== key) return res.status(403).end();
  next();
};

app.get('/health', internalOnly, async (_, res) => {
  const payload = await buildHealthPayload({ mongoose, dbConnected, isProd: IS_PROD });
  res.json(payload);
});

// ─── Readiness endpoint ───────────────────────────────────────────────────
// Liveness (/health) answers "is the process alive". Readiness answers
// "can this instance actually serve traffic right now". A load balancer
// should stop routing to an instance that's alive but not ready (e.g. mid
// startup, feeds not yet connected, wallet not initialized) without
// restarting it — that's the distinction liveness alone can't express.
app.get('/api/readiness', internalOnly, async (_, res) => {
  const checks = { feeds: false, wallet: false, db: true, redis: true };
  const detail = {};

  try {
    const arb = require('./application/arbitrageOrchestrator');
    const st = arb.getStatus?.() || {};
    const feeds = st.feeds || {};
    const feedNames = Object.keys(feeds);
    checks.feeds = feedNames.length > 0 && feedNames.some(k => feeds[k]?.connected !== false);
    detail.feeds = feeds;
  } catch (_) {
    checks.feeds = false;
  }

  try {
    // walletManager initializes its in-memory wallet state synchronously at
    // require-time (no async init() to await) — so a successful require
    // means it's ready. If that ever changes to a real async connection,
    // swap this for an explicit isInitialized() check.
    require('./domain/wallet/walletManager');
    checks.wallet = true;
  } catch (_) {
    checks.wallet = false;
  }

  // DB is only a readiness requirement if a MONGODB_URI was actually
  // configured — in-memory/no-DB mode is a supported, "ready" state.
  if (process.env.MONGODB_URI) {
    checks.db = mongoose.connection.readyState === 1;
  }

  // L-2: same principle for Redis. If REDIS_URL isn't set, in-memory
  // stream tickets are the supported single-instance mode — "ready". If
  // it IS set but Redis is unreachable, stream tickets silently fall back
  // to a per-instance in-memory store, which breaks ticket sharing across
  // horizontally-scaled instances — that's a real "not ready" condition
  // for a multi-instance deployment, not just a log line to miss.
  if (process.env.REDIS_URL) {
    try {
      const { getRedisStatus } = require('./infrastructure/auth');
      const redisStatus = getRedisStatus();
      checks.redis = redisStatus.connected;
      detail.redis = redisStatus;
    } catch (_) {
      checks.redis = false;
    }
  }

  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({
    ok: ready,
    ready,
    checks,
    detail,
    ts: new Date().toISOString(),
  });
});

// ─── Metrics endpoint ─────────────────────────────────────────────────────
// Supports two formats:
//   GET /api/metrics           → JSON (default)
//   GET /api/metrics?format=prometheus  → Prometheus text format (v0.0.4)
//   GET /api/metrics with Accept: text/plain → Prometheus text format
//
// The Prometheus format enables zero-config scraping by Grafana Cloud,
// Datadog Agent, Victoria Metrics, etc. without a sidecar or export process.
app.get('/api/metrics', internalOnly, (req, res) => {
  const wantsPrometheus =
    req.query.format === 'prometheus' ||
    (req.headers.accept || '').includes('text/plain');

  if (wantsPrometheus) {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(metrics.prometheusText());
  }
  res.json({ ok: true, data: metrics.snapshot() });
});


// Audit fix 2.5: business-logic routes extracted from index.js into dedicated
// route modules (SRP). Each module handles its own validation, DB access, and
// error formatting. index.js is now purely wiring/configuration.
app.use(['/api/alerts', '/api/v1/alerts'],       require('./routes/alerts.routes'));
app.use(['/api/watchlist', '/api/v1/watchlist'], require('./routes/watchlist.routes'));
app.use(['/api/portfolio', '/api/v1/portfolio'], require('./routes/portfolio.routes'));


app.use(['/api/dataset', '/api/v1/dataset'], require('./routes/dataset.routes'));

// ADR-017: HTTP surface for the multi-tenant paper-trading primitives
// (tenantBotState/tenantConfig/tenantRiskGuard) — see tenantBot.routes.js
// header for why this route exists (there was previously no way for a
// real user to reach any of that infrastructure).
app.use(['/api/tenant-bot', '/api/v1/tenant-bot'], require('./routes/tenantBot.routes'));
// Iniciativa 4 del plan competitivo: demo de comparación multi-tenant lado
// a lado (dos perfiles de riesgo opuestos) sobre la infraestructura
// multi-tenant real — ver tenantDemo.routes.js para el detalle completo.
app.use(['/api/tenant-demo', '/api/v1/tenant-demo'], require('./routes/tenantDemo.routes'));
app.use(['/api/feature-flags', '/api/v1/feature-flags'], require('./routes/featureFlags.routes'));
app.use(['/api/ops', '/api/v1/ops'], require('./routes/ops.routes'));

// ─── Global error handler ─────────────────────────────────────────────────
// Catches anything not handled by route-level try/catch.
// Audit fix 3.5: now inspects DomainError instances (server/domainErrors.js)
// for status/code/shape so routes can `throw new ValidationError(...)` etc.
// instead of hand-rolling status codes; falls back to a generic 500 for
// anything else. Never exposes stack traces in production.
app.use(require('./domain/errors').expressErrorHandler(logger, IS_PROD));

// ─── Static frontend (production) ────────────────────────────────────────
if (IS_PROD) {
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ─── Server startup ───────────────────────────────────────────────────────
// Guarded so this module can be `require()`d for integration testing
// (e.g. spinning up an ephemeral port to hit /health) without binding the
// configured PORT as a side effect of import. Running `node server/index.js`
// directly still starts the server normally.
let server;
if (require.main === module) {
  server = app.listen(PORT, () => {
    logger.info('index', `Kukora API listening on :${PORT}`, { port: PORT, env: IS_PROD ? 'production' : 'development' });
    if (!IS_PROD) logger.info('index', `UI dev server → http://localhost:5173`);
  });

  // Refinamiento post-Sesión 34, Área 3 — automatización del disparo de
  // rebalanceo. Off por default (liveConfig.autoRebalanceEnabled: false);
  // el loop en sí siempre corre (barato — un chequeo cada 60s), pero solo
  // ACTÚA si un operador lo habilitó explícitamente. `getBestBtcPrice` se
  // requiere de forma perezosa (mismo patrón que el resto de este archivo)
  // para no crear una dependencia circular entre domain/ y application/.
  try {
    const rebalanceScheduler = require('./domain/engines/rebalanceScheduler');
    rebalanceScheduler.startAutoRebalanceLoop(() => {
      try { return require('./application/arbitrage.state').getBestBtcPrice?.(); }
      catch { return 50000; }
    }, 60_000);
  } catch (e) { logger.error('index', 'Failed to start auto-rebalance loop', { err: e.message }); }

  try {
    require('./infrastructure/startupJobs').registerBuiltinJobs();
  } catch (e) { logger.error('index', 'Failed to register background jobs', { err: e.message }); }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('index', `Port ${PORT} is already in use`, { port: PORT });
      logger.error('index', `Run: npx kill-port ${PORT}`);
    } else {
      logger.error('index', 'Server error', { err: err.message });
    }
    process.exit(1);
  });

  // C-4 fix: previously this only closed the HTTP server — it never stopped
  // the 150ms arbitrage loop, never closed the 5 live exchange WebSocket
  // connections, never flushed the persistence retry queue, never drained
  // SSE clients, and never closed the MongoDB connection. On a platform
  // that sends SIGTERM on every deploy (Railway, or SIGINT from `pm2 stop` —
  // see ecosystem.config.js / ADR-016), that meant
  // every deploy had a real chance of dropping a trade mid-persistence-flush
  // and always left dangling WS sockets for the OS to clean up.
  //
  // Order matters: stop producing new work first (loop, WS feeds), then
  // drain what's already in flight (SSE clients, persistence queue), then
  // close infrastructure connections (Mongo), then close the HTTP server.
  // Each step is independently try/catched so one failure (e.g. Mongo
  // already disconnected) doesn't prevent the rest of the shutdown from
  // running — a failed shutdown step should never block process exit.
  const shutdown = async (sig) => {
    logger.info('index', `${sig} — graceful shutdown initiated`);
    const forceExit = setTimeout(() => {
      logger.error('index', 'Graceful shutdown timed out after 5s — forcing exit');
      process.exit(1);
    }, 5000);
    forceExit.unref?.();

    try {
      // 1. Stop the arbitrage loop from scheduling any further ticks.
      try {
        const arb = require('./application/arbitrageOrchestrator');
        arb.stopEngine?.();
      } catch (e) { logger.error('index', 'shutdown: stopEngine failed', { err: e.message }); }

      // 1b. Stop the auto-rebalance loop (Área 3 refinamiento) — same
      // reasoning as stopEngine above, nothing should be scheduling new
      // fund transfers once shutdown has started.
      try {
        require('./domain/engines/rebalanceScheduler').stopAutoRebalanceLoop?.();
      } catch (e) { logger.error('index', 'shutdown: stopAutoRebalanceLoop failed', { err: e.message }); }
      try {
        require('./infrastructure/backgroundJobs').stopAll();
      } catch (e) { logger.error('index', 'shutdown: backgroundJobs.stopAll failed', { err: e.message }); }

      // 2. Close all 5 live exchange WebSocket connections and stop the
      //    reconnect/watchdog machinery so nothing reopens them mid-exit.
      try {
        const exchangeService = require('./infrastructure/exchangeService');
        exchangeService.closeAll?.();
      } catch (e) { logger.error('index', 'shutdown: exchangeService.closeAll failed', { err: e.message }); }

      // 3. Flush any persistence writes still sitting in the retry queue
      //    (M-5) so a trade that failed to persist seconds ago gets one
      //    last attempt before the process exits, and stop the periodic
      //    flush timers so nothing keeps the event loop alive.
      try {
        const persistenceService = require('./infrastructure/persistenceService');
        await persistenceService.flushRetryQueueNow?.();
        persistenceService.stopPeriodicFlush?.();
        persistenceService.stopEngineSnapshotFlush?.();
        persistenceService.stopPersistenceRetryFlush?.();
      } catch (e) { logger.error('index', 'shutdown: persistence flush failed', { err: e.message }); }

      // 4. Drain SSE clients (main stream, alerts, notifications) so
      //    connected browsers get a clean close instead of a dropped
      //    connection with no explanation.
      try {
        const { sseClients, alertsClients, notificationClients } = require('./application/arbitrage.state');
        for (const clients of [sseClients, alertsClients, notificationClients]) {
          for (const res of clients) {
            try { res.end(); } catch { /* client already gone */ }
          }
          clients.clear();
        }
      } catch (e) { logger.error('index', 'shutdown: SSE drain failed', { err: e.message }); }

      // 5. Close the MongoDB connection explicitly instead of letting the
      //    process exit underneath it.
      try {
        if (mongoose.connection.readyState !== 0) {
          await mongoose.connection.close();
        }
      } catch (e) { logger.error('index', 'shutdown: mongoose.connection.close failed', { err: e.message }); }
    } finally {
      // 6. Stop accepting new HTTP connections and exit.
      server.close(() => { clearTimeout(forceExit); process.exit(0); });
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports.app = app;