'use strict';

/**
 * userLiveMode.routes.js — checkpoint-37
 *
 * HTTP surface for server/infrastructure/userLiveModeService.js — lets an
 * authenticated user turn THEIR OWN real-money trading on/off, separate
 * from the global `tradingMode` in liveConfig.js (which remains the
 * platform-wide, operator-only, read-only-from-the-API switch it always
 * was — see liveConfig.js's own header). A trade only executes live when
 * BOTH the global switch and this per-user toggle allow it — see
 * liveExecution.js's `_requireUserLiveModeEnabled()`.
 *
 *   GET  /api/user/live-mode          — current status + the risk disclaimer text to show the user
 *   POST /api/user/live-mode          — enable (requires a connected exchange, a valid 2FA token, and disclaimerAccepted:true)
 *   POST /api/user/live-mode/disable  — disable (always allowed, no 2FA required — turning OFF is never the risky action)
 *
 * All routes require a real authenticated user (requireAuth) — the toggle
 * is keyed on req.userId, never on anything the client sends.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }      = require('../infrastructure/auth');
const { validateBody }     = require('../infrastructure/validateRequest');
const { LiveModeEnableBodySchema } = require('../domain/risk/userExchangeValidation');
const userLiveModeService  = require('../infrastructure/userLiveModeService');
const { sendError }        = require('../infrastructure/errorResponse');

// ─── GET / — current status + disclaimer text ──────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const status = await userLiveModeService.loadLiveModeFromDb(req.userId);
    res.json({
      ok: true,
      data: {
        enabled: status.enabled,
        enabledAt: status.enabledAt,
        disclaimerText: userLiveModeService.RISK_DISCLAIMER_TEXT,
      },
    });
  } catch (e) { sendError(res, e); }
});

// ─── POST / — enable (2FA + explicit disclaimer acceptance required) ──────
router.post('/', requireAuth, validateBody(LiveModeEnableBodySchema), async (req, res) => {
  const { twoFactorToken, disclaimerAccepted } = req.body;
  try {
    const result = await userLiveModeService.enableLiveMode(req.userId, { twoFactorToken, disclaimerAccepted });
    res.json({ ok: true, data: { enabled: result.enabled, enabledAt: result.enabledAt } });
  } catch (e) {
    // Business-rule rejections from the service layer (no exchange
    // connected, bad 2FA token, etc.) are surfaced as 400s, not 500s — the
    // user can fix these themselves without any server-side change.
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── POST /disable — always allowed, no 2FA required ───────────────────────
router.post('/disable', requireAuth, (req, res) => {
  try {
    const result = userLiveModeService.disableLiveMode(req.userId);
    res.json({ ok: true, data: { enabled: result.enabled } });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
