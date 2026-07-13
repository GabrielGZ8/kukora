'use strict';

/**
 * arbitrage/subroutes/config.routes.js — Audit fix 2.1 (SRP refactor)
 * Responsibility: configuration mutations and user-level settings.
 */

const express = require('express');
const router  = express.Router();

const { logger }      = require('../../infrastructure/logger');
const { requireAuth, requireRole } = require('../../infrastructure/auth');
const liveConfig      = require('../../infrastructure/liveConfig');
const { validateArbitrageConfig } = require('../../domain/validation');
const { validateBody } = require('../../infrastructure/validateRequest');
const {
  RebalanceExecuteBodySchema,
  AdversarialRunBodySchema,
} = require('../../domain/risk/arbitrageValidation');
const { PairsBodySchema } = require('../../domain/risk/tradingValidation');
const { DomainError, ValidationError, ForbiddenError } = require('../../domain/errors');

// Audit remediation (roadmap #3 — "terminar la adopción de DomainError en
// los 12 archivos de rutas"). Antes, cada catch de este archivo devolvía un
// 500 (o, en dos rutas, un 400) genérico sin importar la causa real. Ahora
// las validaciones lanzan `ValidationError`/`ForbiddenError` (ya con su
// propio status/code) y este helper respeta ese status en vez de asumir
// uno fijo; el `defaultStatus` solo aplica cuando el error NO es un
// DomainError (comportamiento idéntico al catch original de cada ruta).
function _sendError(e, res, defaultStatus = 500) {
  if (e instanceof DomainError) return res.status(e.status).json(e.toResponse());
  return res.status(defaultStatus).json({ ok: false, error: e.message });
}

const state = require('../../application/arbitrage.state');
const { getBotEnabled, getBotStarted, sseClients, getLastKnownBtcPrice, getBestBtcPrice } = state;

const { getOrderBooks }  = require('../../infrastructure/exchangeService');
const rebalanceEngine    = require('../../domain/engines/rebalanceEngine');
const adversarial        = require('../../domain/risk/adversarialScenarios');
const multiPairService   = require('../../domain/analytics/multiPairService');
const slippageValidator  = require('../../domain/risk/slippageValidator');
const weeklyPnlTracker   = require('../../domain/wallet/weeklyPnlTracker');

function pushToClients(clients, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const r of clients) {
    try { r.write(payload); } catch { clients.delete(r); }
  }
}

router.get('/config', (req, res) => {
  try {
    const cfg = liveConfig.getAll();
    res.json({
      ok: true, data: cfg.current, defaults: cfg.defaults,
      history: cfg.history, changed: cfg.changedKeys, schema: cfg.schema,
      meta: {
        botEnabled:     getBotEnabled(),
        uptimeMs:       Date.now() - getBotStarted(),
        execCooldownMs: require('../../application/arbitrageOrchestrator').getExecCooldown(),
        allExchanges:   liveConfig.ALL_EXCHANGES,
      },
    });
  } catch (e) { _sendError(e, res); }
});

// SECURITY FIX (due diligence, Sesión 2026-07-08): POST /config and
// POST /config/reset mutate `liveConfig`'s single process-wide `_cfg` —
// the SHARED engine config (minScore, tradeAmountBTC, feeMode,
// activeExchanges, risk limits, ...) that the shared/demo bot runs on AND
// that `tenantConfig.getEffective()` falls back to for ANY tenant who
// hasn't set their own override (see tenantConfig.js). Before this fix,
// these two endpoints only required `requireAuth` — ANY authenticated
// user, not just an admin, could silently degrade or manipulate the
// platform-wide config (e.g. set minScore to 100 so the shared bot never
// trades again, or change activeExchanges for everyone). This was
// inconsistent with this exact file's OWN convention for comparably
// risky global mutations two routes below (`/adversarial/run` already
// requires `requireRole('admin')`), and with query.routes.js
// (`/stress-test/activate`, `/risk/circuit-breaker/reset`) — same class
// of "one global switch affects everyone" action, already admin-gated
// there. Safe to apply here too: ADMIN_EMAILS auto-syncs the project
// owner's role on every login (see auth.js `_syncRole`, H-7), so this
// can never lock out the person running the demo.
router.post('/config', requireRole('admin'), (req, res) => {
  try {
    const preCheck = validateArbitrageConfig(req.body);
    if (!preCheck.valid) throw new ValidationError(preCheck.error);

    const result = liveConfig.setMany(req.body || {}, 'ui');
    if (result.applied.length > 0) {
      pushToClients(sseClients, { type: 'config_update', applied: result.applied, state: result.state, ts: new Date().toISOString() });
    }
    res.json({ ok: result.ok, applied: result.applied, rejected: result.rejected, state: result.state });
  } catch (e) { _sendError(e, res); }
});

router.post('/config/reset', requireRole('admin'), (req, res) => {
  try {
    const result = liveConfig.reset('ui');
    pushToClients(sseClients, { type: 'config_reset', reset: result.reset, state: result.state, ts: new Date().toISOString() });
    res.json({ ok: true, reset: result.reset, state: result.state });
  } catch (e) { _sendError(e, res); }
});

router.get('/config/schema', (req, res) => {
  try {
    const all = liveConfig.getAll();
    res.json({ ok: true, data: { schema: all.schema, current: all.current, defaults: all.defaults } });
  } catch (e) { _sendError(e, res); }
});

router.get('/rebalance/analyze', async (req, res) => {
  try {
    const books    = await getOrderBooks().catch(() => []);
    const btcPrice = (books.find(b => b.bid > 0)?.bid) || getLastKnownBtcPrice();
    res.json({ ok: true, data: rebalanceEngine.analyzeBalance(btcPrice), btcPrice });
  } catch (e) { _sendError(e, res); }
});

router.get('/rebalance/suggest', async (req, res) => {
  try {
    const books    = await getOrderBooks().catch(() => []);
    const btcPrice = (books.find(b => b.bid > 0)?.bid) || getLastKnownBtcPrice();
    res.json({ ok: true, data: rebalanceEngine.suggestRebalance(btcPrice), btcPrice });
  } catch (e) { _sendError(e, res); }
});

router.post('/rebalance/execute', validateBody(RebalanceExecuteBodySchema), async (req, res) => {
  try {
    const books      = await getOrderBooks().catch(() => []);
    const btcPrice   = (books.find(b => b.bid > 0)?.bid) || getLastKnownBtcPrice();
    // BUG FIX (refinamiento post-Sesión 34): getLastSuggestion() devuelve el
    // wrapper {suggestions, analysis, ...} — nunca tuvo forma de sugerencia
    // individual, así que este fallback siempre fallaba con "not viable" en
    // la práctica. getTopViableSuggestion() extrae la sugerencia individual
    // de mayor prioridad en la forma plana que executeRebalance espera.
    const suggestion = req.body?.suggestion || rebalanceEngine.getTopViableSuggestion();
    if (!suggestion) return res.json({ ok: false, reason: 'No rebalance suggestion available. Call /suggest first.' });
    const result = rebalanceEngine.executeRebalance(suggestion, btcPrice);
    if (result.ok) {
      pushToClients(sseClients, { type: 'rebalance_executed', entry: result.entry, wallets: result.walletsAfter, ts: new Date().toISOString() });
    }
    res.json({ ok: result.ok, data: result });
  } catch (e) { _sendError(e, res); }
});

router.get('/rebalance/history', (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit,  10) || 50, 200);
    const offset  = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const history = rebalanceEngine.getHistory(limit + offset).slice(offset, offset + limit);
    res.json({ ok: true, data: history, summary: rebalanceEngine.getSummary(), count: history.length, pagination: { limit, offset } });
  } catch (e) { _sendError(e, res); }
});

router.get('/rebalance/predict', (req, res) => {
  try {
    const btcPrice = parseFloat(req.query.btcPrice) || getBestBtcPrice() || 50000;
    res.json({ ok: true, data: rebalanceEngine.getPredictiveRecommendations(btcPrice) });
  } catch (e) { _sendError(e, res); }
});

router.get('/rebalance/consumption', (req, res) => {
  try {
    const windowMs = parseInt(req.query.windowMs, 10) || 3_600_000;
    res.json({ ok: true, data: rebalanceEngine.getConsumptionRates(windowMs) });
  } catch (e) { _sendError(e, res); }
});

router.get('/adversarial/list', (req, res) => {
  res.json({ ok: true, data: adversarial.listAdversarialScenarios() });
});

router.post('/adversarial/run', requireRole('admin'), validateBody(AdversarialRunBodySchema), async (req, res) => {
  try {
    // Fix real (Sesión 19, ver arbitrageValidation.js): antes se llamaba
    // `adversarial.runScenario(req.body || {})` — un solo argumento, así que
    // el objeto completo del body se pasaba como `type` y el switch interno
    // nunca matcheaba nada. El endpoint SIEMPRE devolvía "Escenario
    // desconocido" sin ejecutar ningún escenario. `runScenario(type,
    // orderBooks)` necesita ambos argumentos por separado, y `orderBooks`
    // reales (no undefined) para que `buildBaseOpportunity()` encuentre un
    // par viable en el libro actual.
    const { type } = req.body;
    const books = await getOrderBooks().catch(() => []);
    const result = await adversarial.runScenario(type, books);
    res.json({ ok: true, data: result });
  } catch (e) { _sendError(e, res); }
});

router.get('/adversarial/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    res.json({ ok: true, data: adversarial.getRunHistory(limit) });
  } catch (e) { _sendError(e, res); }
});

router.get('/trading-mode', (req, res) => {
  const mode = process.env.TRADING_MODE || 'paper';
  res.json({
    mode, environment: process.env.NODE_ENV || 'development',
    liveTrading:  mode === 'live',
    paperTrading: mode === 'paper',
    backtesting:  mode === 'backtest',
    description: ({
      paper:    'Paper trading — real prices, simulated execution, no real funds',
      live:     'Live trading — real prices, real execution, real funds',
      backtest: 'Backtesting — historical prices, no real-time execution',
    })[mode] || 'Unknown mode',
  });
});

router.get('/mode', (req, res) => {
  try {
    const userId     = req.userId || 'default';
    const userConfig = multiPairService.getUserConfig(userId);
    const liveEnabled = process.env.LIVE_TRADING_ENABLED === 'true'
      && !!process.env.BINANCE_API_KEY && !!process.env.BINANCE_API_SECRET;
    res.json({ ok: true, data: { mode: userConfig.mode || 'paper', liveEnabled } });
  } catch (e) { _sendError(e, res); }
});

router.post('/mode', (req, res) => {
  try {
    const userId = req.userId || 'default';
    const { mode } = req.body || {};
    if (!['paper', 'live'].includes(mode)) {
      throw new ValidationError("mode must be 'paper' or 'live'");
    }
    const liveEnabled = process.env.LIVE_TRADING_ENABLED === 'true'
      && !!process.env.BINANCE_API_KEY && !!process.env.BINANCE_API_SECRET;
    if (mode === 'live' && !liveEnabled) {
      throw new ForbiddenError('Live trading is disabled. Set LIVE_TRADING_ENABLED=true and configure Binance API keys.');
    }
    const current = multiPairService.getUserConfig(userId);
    const updated = multiPairService.setUserConfig(userId, { ...current, mode });
    logger.info('arbitrage', 'Trading mode changed', { userId, mode });
    res.json({ ok: true, data: { mode: updated.mode, liveEnabled } });
  } catch (e) { _sendError(e, res, 400); }
});

router.get('/pairs', (req, res) => {
  try {
    const userId     = req.userId || 'default';
    const userConfig = multiPairService.getUserConfig(userId);
    res.json({ ok: true, data: { userConfig, supported: Object.keys(multiPairService.SUPPORTED_PAIRS) } });
  } catch (e) { _sendError(e, res); }
});

router.post('/pairs', validateBody(PairsBodySchema), (req, res) => {
  try {
    const userId = req.userId || 'default';
    const { pairs, allocation } = req.body;
    // Defense in depth (mismo criterio que rebalanceEngine.executeRebalance):
    // validateBody ya rechaza esto con 400 en producción, pero los tests
    // unitarios de este router llaman al handler final directamente,
    // saltándose el middleware — este guard preserva el 400 en ambos casos.
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new ValidationError('pairs must be a non-empty array');
    }
    res.json({ ok: true, data: multiPairService.setUserConfig(userId, { pairs, allocation }) });
  } catch (e) { _sendError(e, res, 400); }
});

router.get('/calibration', requireAuth, (req, res) => {
  try { res.json({ ok: true, data: slippageValidator.getCalibrationStats() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/weekly', requireAuth, (req, res) => {
  try { res.json({ ok: true, data: weeklyPnlTracker.getWeeklyStats() }); }
  catch (e) { _sendError(e, res); }
});

module.exports = router;
