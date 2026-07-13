'use strict';

/**
 * tenantDemo.routes.js — ADR-017 follow-up, Iniciativa 4 del plan
 * competitivo (comparación multi-tenant demo para el jurado).
 *
 * PROBLEMA: la infraestructura multi-tenant (`tenantBotState`,
 * `tenantConfig`, `tenantExecution`, `tenantRiskGuard`) existe y ya está
 * conectada al loop de ejecución de 150ms (ver
 * `arbitrageOrchestrator.js` → `runTenantExecutionPass`), pero no había
 * ninguna forma de VER esa capacidad en acción sin tener dos cuentas de
 * usuario reales registradas y logueadas simultáneamente en dos
 * pestañas — nada demostrable en una sola pantalla.
 *
 * SOLUCIÓN: dos tenants demo (`demo-conservative`, `demo-aggressive`)
 * con overrides de config genuinos y opuestos, aplicados vía el mismo
 * mecanismo (`tenantConfig.setMany`) que usaría cualquier usuario real
 * desde `tenantBot.routes.js` — no hay atajo ni simulación paralela, es
 * el mismo motor de ejecución multi-tenant real corriendo con datos
 * sintéticos en vez de una sesión de usuario real.
 *
 *   conservative: minScore alto (80) + trade size chico (0.005 BTC)
 *                 → selectivo, pocas operaciones, bajo riesgo por trade.
 *   aggressive:   minScore bajo (40) + trade size grande (0.02 BTC)
 *                 → más operaciones aceptadas, mayor exposición por trade.
 *
 * Una vez `enabled`, ambos tenants son recogidos automáticamente por
 * `tenantBotState.activeUids()` en cada tick del loop compartido —
 * exactamente igual que un usuario real que prendió su bot desde
 * `/api/tenant-bot/toggle`. Esto también significa que aparecen solos en
 * la sección "Multi-Tenant Snapshot" del Judge Report
 * (`server/domain/analytics/judgeReport.js`) sin código adicional.
 *
 * Aislado de cuentas reales: los uids `demo-*` nunca corresponden a un
 * `User` real en Mongo — son claves opacas para `tenantStore` (ver su
 * comentario: "nunca interpreta la clave"). `POST /stop` los apaga pero
 * deliberadamente NO borra su wallet/historial (mismo criterio que
 * `tenantBot.routes.js` POST /toggle: apagar el bot no debe destruir el
 * historial de lo que ya hizo) — así un jurado puede prender, ver
 * resultados, apagar, y volver a ver el mismo estado sin perder nada;
 * `POST /reset` sí lo limpia por completo si se quiere arrancar de cero.
 *
 * Gateado por requireAuth (cualquier usuario logueado puede correr la
 * demo — no muta datos de otros usuarios reales, solo las dos cuentas
 * sintéticas) y por financialControlLimiter en las mutaciones (ver
 * server/index.js), mismo criterio que tenant-bot.routes.js.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }  = require('../infrastructure/auth');
const tenantBotState    = require('../infrastructure/tenantBotState');
const tenantConfig      = require('../infrastructure/tenantConfig');
const tenantRiskGuard   = require('../infrastructure/tenantRiskGuard');
const { getBalances, getPnL, getTradeHistory, resetBalances } = require('../domain/wallet/walletManager');
const { sendError } = require('../infrastructure/errorResponse');

const DEMO_UIDS = Object.freeze({
  conservative: 'demo-conservative',
  aggressive:   'demo-aggressive',
});

const DEMO_PROFILES = Object.freeze({
  [DEMO_UIDS.conservative]: { minScore: 80, tradeAmountBTC: 0.005 },
  [DEMO_UIDS.aggressive]:   { minScore: 40, tradeAmountBTC: 0.02  },
});

function _snapshotTenant(uid, label) {
  const pnl = getPnL(null, null, uid);
  return {
    uid,
    label,
    botStatus:      tenantBotState.getStatus(uid),
    wallets:        getBalances(uid),
    pnl,
    trades:         getTradeHistory(uid).length,
    history:        getTradeHistory(uid).slice(-10).reverse(),
    configOverrides: tenantConfig.getOverrides(uid),
    risk:           tenantRiskGuard.getStatus(uid),
  };
}

// ─── POST /start — create/enable both demo tenants with opposing profiles ──
router.post('/start', requireAuth, (req, res) => {
  try {
    const results = {};
    for (const [key, uid] of Object.entries(DEMO_UIDS)) {
      const profile = DEMO_PROFILES[uid];
      const configResult = tenantConfig.setMany(uid, profile);
      tenantBotState.setEnabled(uid, true);
      results[key] = { uid, profile, configApplied: configResult };
    }
    res.json({ ok: true, data: results, message: 'Demo tenants started — both are now picked up by the live 150ms execution loop.' });
  } catch (e) { sendError(res, e); }
});

// ─── GET /status — side-by-side snapshot of both demo tenants ─────────────
router.get('/status', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, data: {
      conservative: _snapshotTenant(DEMO_UIDS.conservative, 'Conservative'),
      aggressive:   _snapshotTenant(DEMO_UIDS.aggressive,   'Aggressive'),
    }});
  } catch (e) { sendError(res, e); }
});

// ─── POST /stop — disable both bots, keep wallets/history intact ──────────
router.post('/stop', requireAuth, (req, res) => {
  try {
    for (const uid of Object.values(DEMO_UIDS)) {
      tenantBotState.setEnabled(uid, false);
    }
    res.json({ ok: true, message: 'Demo tenants stopped. Wallets and trade history preserved — use /reset to clear.' });
  } catch (e) { sendError(res, e); }
});

// ─── POST /reset — stop + wipe wallets/history/config/risk for both demos ─
router.post('/reset', requireAuth, (req, res) => {
  try {
    for (const uid of Object.values(DEMO_UIDS)) {
      tenantBotState.setEnabled(uid, false);
      resetBalances(uid);
      tenantConfig.resetAll(uid);
      tenantRiskGuard.resetBreaker(uid);
    }
    res.json({ ok: true, message: 'Demo tenants fully reset.' });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
