'use strict';

/**
 * arbitrage.routes.js — kukora arbitrage engine (thin wiring file)
 *
 * Audit fix 2.1 (SRP refactor): this file used to contain all ~1247 lines of
 * arbitrage HTTP routes in one place. It now only:
 *   1. Applies the shared auth middleware for the /api/arbitrage/* namespace
 *   2. Starts the detection engine
 *   3. Mounts three focused sub-routers by responsibility:
 *
 *      server/arbitrage/subroutes/stream.routes.js — SSE streams, bot control,
 *                                                  reset, history, wallets
 *      server/arbitrage/subroutes/query.routes.js  — all read-only data queries
 *                                                  (stats, intelligence, reports)
 *      server/arbitrage/subroutes/config.routes.js — config mutations, rebalance,
 *                                                  trading mode, pairs, calibration
 *
 * Every endpoint path and response shape is unchanged — this is a pure
 * structural refactor, transparent to the frontend.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../infrastructure/auth');
const { startEngine } = require('../application/arbitrageOrchestrator');
// C-1 fix: exchangeService's 5 live WS connections used to open as a
// require()-time side effect of exchangeService.js itself. init() is now
// explicit and called from here — the one place that means "the server is
// actually starting" — instead of firing for anyone who merely requires
// the module (tests, scripts, other services that only need a helper fn).
const exchangeService = require('../infrastructure/exchangeService');

// Issue 3: Protect all arbitrage routes — requires valid JWT.
// SSE stream endpoints use their own ticket-based auth (token in query param)
// instead, since EventSource cannot set an Authorization header.
router.use((req, res, next) => {
  if (req.path === '/stream' || req.path === '/alerts-stream') return next();
  // Read-only status endpoints that SystemStatusBar calls before token is ready.
  if (req.path === '/alerts/history' || req.path === '/trading-mode') return next();
  return requireAuth(req, res, next);
});

// ─── Start the detection engine ────────────────────────────────────────────
// C-1: open the 5 live exchange WS connections explicitly, right alongside
// starting the detection loop — not as a side effect of merely requiring
// exchangeService.js.
exchangeService.init();
startEngine();

// ─── Mount sub-routers ──────────────────────────────────────────────────────
router.use('/', require('../arbitrage/subroutes/stream.routes'));
router.use('/', require('../arbitrage/subroutes/query.routes'));
router.use('/', require('../arbitrage/subroutes/config.routes'));

module.exports = router;
