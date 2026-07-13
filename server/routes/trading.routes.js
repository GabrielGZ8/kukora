'use strict';
/**
 * trading.routes.js — Kukora
 *
 * C-2: rutas de trading que vivían inline en server/index.js, extraídas a
 * un router dedicado siguiendo el mismo patrón ya aplicado a
 * alerts/watchlist/portfolio/dataset (ver "Audit fix 2.5" en index.js) y a
 * crypto/arbitrage/notifications (que ya vivían en su propio router desde
 * antes). Cambio puramente de organización de código — cero cambio de
 * comportamiento: mismos paths, mismo orden de middlewares, mismas
 * respuestas. El rate-limiting específico de estos endpoints
 * (financialControlLimiter en '/api/trading/mode', '/api/trading/2fa',
 * '/api/trading/execute') se queda registrado en index.js tal como estaba
 * — son app.use(path, mw) a nivel de app que ya corren antes de que
 * cualquier request llegue a este router montado en '/api/trading', así
 * que moverlos aquí no cambia nada y sí hubiera sido un segundo cambio sin
 * necesidad.
 *
 * Endpoints (13 — el plan original decía 14; recontado directamente sobre
 * el código antes de mover nada, ver MIGRATION_CLEANUP_LOG.md Sesión 13):
 *   GET  /api/trading/mode
 *   POST /api/trading/mode
 *   GET  /api/trading/audit
 *   POST /api/trading/test-connection
 *   POST /api/trading/execute/cross
 *   GET  /api/trading/rate-limits
 *   GET  /api/trading/reconciliation
 *   POST /api/trading/2fa/setup
 *   POST /api/trading/2fa/confirm
 *   GET  /api/trading/2fa/status
 *   POST /api/trading/2fa/disable
 *   GET  /api/trading/pairs
 *   POST /api/trading/pairs
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }             = require('../infrastructure/auth');
const { validateBody }            = require('../infrastructure/validateRequest');
const liveExecution                = require('../application/liveExecution');
const multiPairService             = require('../domain/analytics/multiPairService');
const userRiskProfileService       = require('../domain/risk/userRiskProfileService');
const twoFactor                    = require('../application/twoFactor');
const liveInventoryReconciliation  = require('../application/liveInventoryReconciliation');
const {
  ModeBodySchema,
  TestConnectionBodySchema,
  ExecuteCrossBodySchema,
  TwoFactorTokenBodySchema,
  PairsBodySchema,
  RiskProfileBodySchema,
} = require('../domain/risk/tradingValidation');
const { sendError } = require('../infrastructure/errorResponse');
const { UnauthorizedError } = require('../domain/errors');

// ─── Live Trading Routes (GAP 1) ─────────────────────────────────────────
// Issue 2: All trading-control routes now require authentication
router.get('/mode', requireAuth, (req, res) => {
  const mode = liveExecution.getUserMode(req.userId || 'anonymous');
  res.json({ ok: true, data: { mode, liveEnabled: liveExecution.LIVE_ENABLED } });
});

router.post('/mode', requireAuth, validateBody(ModeBodySchema), (req, res) => {
  const { mode, twoFactorToken } = req.body || {};
  const userId = req.userId || 'anonymous';
  try {
    // Fase 3 pendiente #1: switching INTO live mode is gated behind TOTP
    // 2FA once the user has enrolled (GET /api/trading/2fa/status). Users
    // who never enrolled can still switch (backward-compatible — 2FA
    // enrollment itself isn't force-mandated), but once enrolled, a valid
    // current token is required every time, same as disabling 2FA.
    if (mode === 'live' && twoFactor.isEnabled(userId)) {
      if (!twoFactor.verify(userId, twoFactorToken)) {
        return sendError(res, new UnauthorizedError('Invalid or missing 2FA token (twoFactorToken)'));
      }
    }
    liveExecution.setUserMode(userId, mode);
    res.json({ ok: true, data: { mode } });
  } catch (e) {
    sendError(res, e, { fallbackStatus: 400 });
  }
});

router.get('/audit', requireAuth, (req, res) => {
  res.json({ ok: true, data: { log: liveExecution.getAuditLog().slice(0, 100) } });
});

router.post('/test-connection', requireAuth, validateBody(TestConnectionBodySchema), async (req, res) => {
  const { exchange, apiKey, apiSecret, apiPassphrase } = req.body || {};
  const result = await liveExecution.testExchangeConnection(exchange, apiKey, apiSecret, apiPassphrase);
  res.json({ ok: result.ok, data: result });
});

// ─── Cross-exchange live execution (Fase 3) ───────────────────────────────
// Places a real dual-leg trade (buy on opportunity.buyExchange, sell on
// opportunity.sellExchange). Requires 2FA if the user has it enabled, same
// gate as switching into live mode above — placing a live order is at
// least as sensitive as toggling the mode that permits it.
router.post('/execute/cross', requireAuth, validateBody(ExecuteCrossBodySchema), async (req, res) => {
  const { opportunity, amount, twoFactorToken } = req.body || {};
  const userId = req.userId || 'anonymous';
  if (twoFactor.isEnabled(userId) && !twoFactor.verify(userId, twoFactorToken)) {
    return sendError(res, new UnauthorizedError('Invalid or missing 2FA token (twoFactorToken)'));
  }
  try {
    const result = await liveExecution.executeCrossExchangeLive(opportunity, userId, amount);
    res.json({ ok: true, data: result });
  } catch (e) {
    // Partial-execution failures (e.partial) keep their own 207 shape — not
    // a DomainError concern, this is execution-specific recovery metadata.
    if (e.partial) {
      return res.status(207).json({ ok: false, error: e.message, partial: true, recovery: e.recovery });
    }
    sendError(res, e, { fallbackStatus: 400 });
  }
});

// ─── Exchange rate-limit status (Fase 3 pendiente #2) ─────────────────────
router.get('/rate-limits', requireAuth, (req, res) => {
  res.json({ ok: true, data: liveExecution.getExchangeRateLimitStatus() });
});

// ─── Live inventory reconciliation (Fase 3 pendiente #5) ──────────────────
// Reactive (concentration threshold) + predictive (directional bias of the
// last N cross-exchange trades, see directionalBiasTracker.js) suggestions.
// Each entry in data.suggestions carries trigger: 'reactive' | 'predictive'.
router.get('/reconciliation', requireAuth, async (req, res) => {
  const { quoteAsset, baseAsset, exchanges } = req.query || {};
  try {
    const result = await liveInventoryReconciliation.checkInventory({
      quoteAsset: quoteAsset || undefined,
      baseAsset: baseAsset || undefined,
      exchanges: exchanges ? String(exchanges).split(',').map(s => s.trim().toLowerCase()) : undefined,
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    sendError(res, e, { fallbackStatus: 500 });
  }
});

// ─── 2FA enrollment / verification (Fase 3 pendiente #1) ──────────────────
router.post('/2fa/setup', requireAuth, (req, res) => {
  const userId = req.userId || 'anonymous';
  const { secret, otpauthUrl } = twoFactor.beginSetup(userId, { accountName: req.userEmail || userId });
  res.json({ ok: true, data: { secret, otpauthUrl } });
});

router.post('/2fa/confirm', requireAuth, validateBody(TwoFactorTokenBodySchema), (req, res) => {
  const userId = req.userId || 'anonymous';
  const { token } = req.body || {};
  try {
    const result = twoFactor.confirmSetup(userId, token);
    res.json({ ok: true, data: result });
  } catch (e) {
    sendError(res, e, { fallbackStatus: 400 });
  }
});

router.get('/2fa/status', requireAuth, (req, res) => {
  const userId = req.userId || 'anonymous';
  res.json({ ok: true, data: twoFactor.getStatus(userId) });
});

router.post('/2fa/disable', requireAuth, validateBody(TwoFactorTokenBodySchema), (req, res) => {
  const userId = req.userId || 'anonymous';
  const { token } = req.body || {};
  try {
    const result = twoFactor.disable(userId, token);
    res.json({ ok: true, data: result });
  } catch (e) {
    sendError(res, e, { fallbackStatus: 400 });
  }
});

// ─── Multi-Pair Routes (GAP 4) ────────────────────────────────────────────
router.get('/pairs', requireAuth, (req, res) => {
  const userConfig = multiPairService.getUserConfig(req.userId || 'anonymous');
  res.json({ ok: true, data: { supported: Object.keys(multiPairService.SUPPORTED_PAIRS), userConfig } });
});

router.post('/pairs', requireAuth, validateBody(PairsBodySchema), (req, res) => {
  try {
    const config = multiPairService.setUserConfig(req.userId || 'anonymous', req.body || {});
    res.json({ ok: true, data: config });
  } catch (e) {
    sendError(res, e, { fallbackStatus: 400 });
  }
});

// ─── Per-user risk profile (refinamiento post-Sesión 34 — "Profundidad y
// parametrización") ────────────────────────────────────────────────────────
// Overrides individuales sobre los límites globales de liveConfig, aplicados
// por userRiskProfileService.getEffectiveConfig() dentro de
// `_runInstitutionalRiskGate()` en liveExecution.js justo antes de cualquier
// ejecución live/cross-exchange de ESE usuario. `effective` en la respuesta
// GET muestra el valor que REALMENTE rige ahora mismo (override propio ya
// recortado contra el límite global vigente), no solo lo que el usuario
// guardó — para que la UI nunca muestre un número más laxo del que en la
// práctica se está aplicando.
router.get('/risk-profile', requireAuth, (req, res) => {
  try {
    const userId = req.userId || 'anonymous';
    res.json({ ok: true, data: {
      profile:   userRiskProfileService.getUserRiskProfile(userId),
      effective: userRiskProfileService.getEffectiveConfig(userId),
    } });
  } catch (e) { sendError(res, e, { fallbackStatus: 500 }); }
});

router.post('/risk-profile', requireAuth, validateBody(RiskProfileBodySchema), (req, res) => {
  try {
    const userId = req.userId || 'anonymous';
    const profile = userRiskProfileService.setUserRiskProfile(userId, req.body || {});
    res.json({ ok: true, data: { profile, effective: userRiskProfileService.getEffectiveConfig(userId) } });
  } catch (e) {
    sendError(res, e, { fallbackStatus: 400 });
  }
});

module.exports = router;
