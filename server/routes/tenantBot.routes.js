'use strict';

/**
 * tenantBot.routes.js — ADR-017, HTTP surface for the multi-tenant
 * primitives built across several sessions (tenantBotState, tenantConfig,
 * tenantExecution, tenantSseDelta, tenantPersistence, tenantRiskGuard).
 *
 * FINDING (Sesión 2026-07-07, item 2 follow-up): before this file, none
 * of those modules had any route a real authenticated user could reach —
 * there was no way for a user to turn on their own paper-trading bot, set
 * their own config overrides, or see/reset their own risk-guard status.
 * The entire multi-tenant execution engine existed purely as backend
 * infrastructure with zero HTTP surface. This route closes that gap.
 *
 *   GET    /api/tenant-bot/status        — bot on/off, wallet, P&L, history, risk status
 *   POST   /api/tenant-bot/toggle        — { enabled: boolean } — turn the caller's bot on/off
 *   GET    /api/tenant-bot/config        — the caller's config overrides
 *   POST   /api/tenant-bot/config        — { patch: { key: value, ... } } — apply overrides
 *   DELETE /api/tenant-bot/config/:key   — clear a single override
 *   POST   /api/tenant-bot/config/reset  — clear ALL overrides for the caller
 *   POST   /api/tenant-bot/risk/reset    — reset the caller's tripped risk-guard breaker
 *
 * All routes require a real authenticated user (requireAuth) — uid always
 * comes from req.userId, never from the request body, so one tenant can
 * never read or mutate another tenant's state.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }   = require('../infrastructure/auth');
const tenantBotState    = require('../infrastructure/tenantBotState');
const tenantConfig      = require('../infrastructure/tenantConfig');
const tenantRiskGuard   = require('../infrastructure/tenantRiskGuard');
const tenantPersistence = require('../infrastructure/tenantPersistence');
const { getBalances, getPnL, getTradeHistory } = require('../domain/wallet/walletManager');
const { sendError } = require('../infrastructure/errorResponse');
const { ValidationError } = require('../domain/errors');

// ─── GET /status ────────────────────────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
  const uid = req.userId;
  try {
    res.json({
      ok: true,
      data: {
        botStatus:      tenantBotState.getStatus(uid),
        wallets:         getBalances(uid),
        pnl:             getPnL(null, null, uid),
        history:         getTradeHistory(uid).slice(-20).reverse(),
        configOverrides: tenantConfig.getOverrides(uid),
        risk:            tenantRiskGuard.getStatus(uid),
      },
    });
  } catch (e) { sendError(res, e); }
});

// ─── POST /toggle ───────────────────────────────────────────────────────────
router.post('/toggle', requireAuth, async (req, res) => {
  const uid = req.userId;
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return sendError(res, new ValidationError('`enabled` must be a boolean'));
  }
  try {
    const wasEnabled = tenantBotState.isEnabled(uid);
    const status = tenantBotState.setEnabled(uid, enabled);

    // Best-effort restore on first enable in this process — see
    // tenantPersistence.js. Never blocks/fails the toggle itself.
    if (enabled && !wasEnabled) {
      await tenantPersistence.restoreTenantSnapshot(uid).catch(() => null);
    }

    res.json({ ok: true, data: status });
  } catch (e) { sendError(res, e); }
});

// ─── GET /config ────────────────────────────────────────────────────────────
router.get('/config', requireAuth, (req, res) => {
  try { res.json({ ok: true, data: tenantConfig.getOverrides(req.userId) }); }
  catch (e) { sendError(res, e); }
});

// ─── POST /config ───────────────────────────────────────────────────────────
router.post('/config', requireAuth, (req, res) => {
  const { patch } = req.body || {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return sendError(res, new ValidationError('`patch` must be an object of key/value overrides'));
  }
  try {
    const result = tenantConfig.setMany(req.userId, patch);
    // BUG FIX (Sesión 2026-07-07, tenant-bot UI follow-up): a partial
    // rejection (e.g. one bad key in a multi-key patch) is an
    // application-level outcome, not a protocol-level error — same
    // convention already used by POST /api/arbitrage/config (always 200,
    // `ok` reflects whether every key applied). Returning 400 here made
    // this endpoint behave differently from its sibling AND broke every
    // generic frontend helper that treats non-2xx as a hard failure
    // (src/api.js's post()/get() throw and discard the response body —
    // including `data.rejected`, the one thing the caller needed to show
    // the user *why* something didn't apply). `result.ok` in the body
    // still communicates success/partial-failure accurately.
    res.status(200).json({ ok: result.ok, data: result });
  } catch (e) { sendError(res, e); }
});

// ─── DELETE /config/:key ────────────────────────────────────────────────────
router.delete('/config/:key', requireAuth, (req, res) => {
  try {
    tenantConfig.clearOverride(req.userId, req.params.key);
    res.json({ ok: true, data: tenantConfig.getOverrides(req.userId) });
  } catch (e) { sendError(res, e); }
});

// ─── POST /config/reset ──────────────────────────────────────────────────────
router.post('/config/reset', requireAuth, (req, res) => {
  try {
    tenantConfig.resetAll(req.userId);
    res.json({ ok: true, data: tenantConfig.getOverrides(req.userId) });
  } catch (e) { sendError(res, e); }
});

// ─── POST /risk/reset ────────────────────────────────────────────────────────
router.post('/risk/reset', requireAuth, (req, res) => {
  try {
    const result = tenantRiskGuard.resetBreaker(req.userId);
    res.status(result.ok ? 200 : 400).json({ ok: result.ok, data: tenantRiskGuard.getStatus(req.userId), error: result.ok ? undefined : result.reason });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
