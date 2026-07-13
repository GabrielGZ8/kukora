'use strict';
/**
 * tenantRiskGuard.js — ADR-017, pendiente #3 (risk engine per-tenant).
 *
 * CONTEXTO: `advancedRiskEngine.js` es un único cerebro global — un solo
 * juego de variables de módulo (`_peakEquity`, `_circuitBreakerActive`,
 * etc.) protegiendo el bot compartido. Eso es una decisión de arquitectura
 * defendible para el bot compartido (ver `tenantExecution.js`, cabecera:
 * "un único motor de detección compartido"), pero significa que hoy NO
 * existe ningún circuit breaker, límite de drawdown, ni guard de tamaño de
 * posición POR TENANT — un tenant con una config agresiva (minScore bajo,
 * tradeAmountBTC alto) puede vaciar SU PROPIO wallet sin que nada lo
 * detenga, aunque no pueda tocar el wallet de otro tenant ni del bot
 * compartido (ver `walletManager` — aislamiento de balances ya existe).
 *
 * ALCANCE (deliberadamente acotado, mismo criterio que `tenantSseDelta.js`
 * y `tenantPersistence.js`): un módulo NUEVO y aditivo, NO un refactor de
 * `advancedRiskEngine.js` a multi-instancia. Reusa lo que `walletManager`
 * YA calcula por-tenant (`getPnL(uid).maxDrawdown`, `.currentStreak`,
 * `.currentStreakType`) en vez de duplicar el tracking de equity/peak que
 * `advancedRiskEngine` mantiene para el bot compartido.
 *
 * LO QUE SÍ CUBRE:
 *   - Límite de drawdown por-tenant (`tenantConfig.getEffective(uid,
 *     'maxDrawdownPct')` — misma clave ya validada por `liveConfig`, hoy
 *     sin ningún consumidor per-tenant).
 *   - Circuit breaker por-tenant: se activa (no se auto-resetea por
 *     timeout, mismo criterio que 'drawdown'/'manual' en
 *     `advancedRiskEngine`) cuando el drawdown excede el límite, o tras N
 *     pérdidas consecutivas (`MAX_CONSECUTIVE_LOSSES`, constante).
 *   - Guard de tamaño de posición por-tenant (`maxPositionValueUSD`).
 *   - Límite de pérdida diaria por-tenant (`maxDailyLossUSD`) — BUG FIX
 *     (due diligence, Sesión 2026-07-08): esta clave ya era validada y
 *     guardable como override desde TenantBotPanel.jsx (el frontend la
 *     mostraba, la guardaba, y `tenantConfig.getEffective` la devolvía sin
 *     error) pero **ningún código la leía nunca** — un usuario podía
 *     configurar "detente si pierdo más de $100 hoy" y el sistema lo
 *     aceptaba en silencio sin aplicarlo jamás. Ahora `checkPreTrade` la
 *     evalúa contra el P&L realizado del día (mismo criterio de reset a
 *     medianoche que usa `opportunityDetection._addDailyPnl` para el bot
 *     compartido, pero calculado aquí a partir del `tradeHistory` que
 *     `walletManager` ya trackea por-tenant — no requiere estado nuevo).
 *   - Reset manual por-tenant (`resetBreaker(uid)`).
 *
 * LO QUE NO CUBRE (fuera de alcance, documentado — no escondido):
 *   - Exposure limits por-exchange/por-asset.
 *   - Slippage/latency history tracking per-tenant.
 *   - `MAX_CONSECUTIVE_LOSSES` no es una clave configurable de
 *     `tenantConfig` todavía — es una constante de módulo.
 *
 * AISLAMIENTO: estado en `createTenantStore` (mismo primitivo que
 * wallets/config/bot-state) — el breaker de un tenant nunca afecta a otro
 * tenant ni al bot compartido (protegido, sin cambios, por
 * `advancedRiskEngine.js`).
 */

const { createTenantStore } = require('./tenantStore');
const tenantConfig = require('./tenantConfig');
const { getPnL, getTradeHistory } = require('../domain/wallet/walletManager');
const { logger } = require('./logger');

const MAX_CONSECUTIVE_LOSSES = 5;

const _breakers = createTenantStore(() => ({
  active: false,
  reason: null,
  triggerType: null,
  activatedAt: null,
}));

function getStatus(uid) {
  return { ..._breakers.get(uid) };
}

function isTripped(uid) {
  return !!_breakers.get(uid).active;
}

function tripBreaker(uid, reason, triggerType = 'manual') {
  const state = _breakers.get(uid);
  if (state.active) return { ok: true, alreadyActive: true, reason: state.reason };
  state.active = true;
  state.reason = reason;
  state.triggerType = triggerType;
  state.activatedAt = new Date().toISOString();
  logger.warn('tenantRiskGuard', 'Per-tenant circuit breaker activated', { uid, reason, triggerType });
  return { ok: true, alreadyActive: false, reason, triggerType, activatedAt: state.activatedAt };
}

function resetBreaker(uid) {
  const state = _breakers.get(uid);
  if (!state.active) return { ok: false, reason: 'Circuit breaker not active' };
  state.active = false;
  state.reason = null;
  state.triggerType = null;
  state.activatedAt = null;
  logger.info('tenantRiskGuard', 'Per-tenant circuit breaker reset', { uid });
  return { ok: true };
}

/**
 * _todaysRealizedPnl — sums netProfit for this tenant's trades since local
 * midnight. Derived from `getTradeHistory(uid)` (already per-tenant, no new
 * state to keep isolated) — `trade.ts` is either an ISO string (production,
 * set by `executeSimulated`) or a numeric epoch ms (some test fixtures);
 * `new Date(ts)` handles both.
 */
function _todaysRealizedPnl(uid) {
  const todayMidnight = new Date().setHours(0, 0, 0, 0);
  const history = getTradeHistory(uid);
  return history.reduce((sum, t) => {
    const ts = t.ts ? new Date(t.ts).getTime() : 0;
    return ts >= todayMidnight ? sum + (t.netProfit || 0) : sum;
  }, 0);
}

/**
 * checkPreTrade — llamada antes de ejecutar un trade para ESE tenant.
 * Efecto secundario documentado (posible activación del breaker), mismo
 * criterio que `advancedRiskEngine.checkDrawdown`.
 * @param {string} uid
 * @param {number} [tradeValueUSD] — valor aproximado de la posición en USD
 * @returns {{ok:boolean, reason?:string}}
 */
function checkPreTrade(uid, tradeValueUSD) {
  if (isTripped(uid)) {
    return { ok: false, reason: `Tenant circuit breaker active: ${_breakers.get(uid).reason}` };
  }

  let pnl;
  try { pnl = getPnL(null, null, uid); } catch { pnl = null; }

  if (pnl) {
    const maxDrawdownPct = tenantConfig.getEffective(uid, 'maxDrawdownPct');
    if (typeof maxDrawdownPct === 'number' && pnl.maxDrawdown >= maxDrawdownPct) {
      const reason = `Drawdown ${pnl.maxDrawdown.toFixed(2)}% exceeds maximum ${maxDrawdownPct}%`;
      tripBreaker(uid, reason, 'drawdown');
      return { ok: false, reason };
    }
    if (pnl.currentStreakType === 'loss' && pnl.currentStreak >= MAX_CONSECUTIVE_LOSSES) {
      const reason = `${pnl.currentStreak} consecutive losses (limit ${MAX_CONSECUTIVE_LOSSES})`;
      tripBreaker(uid, reason, 'consecutive_losses');
      return { ok: false, reason };
    }
  }

  const maxDailyLossUSD = tenantConfig.getEffective(uid, 'maxDailyLossUSD');
  if (typeof maxDailyLossUSD === 'number' && maxDailyLossUSD < 0) {
    const dailyPnl = _todaysRealizedPnl(uid);
    if (dailyPnl <= maxDailyLossUSD) {
      const reason = `Daily P&L $${dailyPnl.toFixed(2)} at or below limit $${maxDailyLossUSD}`;
      tripBreaker(uid, reason, 'daily_loss');
      return { ok: false, reason };
    }
  }

  if (typeof tradeValueUSD === 'number') {
    const maxPositionValueUSD = tenantConfig.getEffective(uid, 'maxPositionValueUSD');
    if (typeof maxPositionValueUSD === 'number' && tradeValueUSD > maxPositionValueUSD) {
      return {
        ok: false,
        reason: `Position value $${tradeValueUSD.toFixed(2)} exceeds maximum $${maxPositionValueUSD}`,
      };
    }
  }

  return { ok: true };
}

module.exports = {
  checkPreTrade,
  tripBreaker,
  resetBreaker,
  isTripped,
  getStatus,
  MAX_CONSECUTIVE_LOSSES,
};
