'use strict';
/**
 * tenantPersistence.js — ADR-017, pendiente #2 (persistencia por-tenant).
 *
 * PROBLEMA: `persistenceService.startEngineSnapshotFlush(getSnapshotFn,
 * userId, intervalMs)` solo soporta UN slot global (`_snapshotInterval`)
 * — llamarlo una segunda vez con otro `userId` reemplaza el primero. Eso
 * es correcto para el bot compartido (un único snapshot, `userId:
 * 'default'`), pero significa que no hay ningún mecanismo hoy para
 * persistir el estado de N tenants activos en paralelo. Si el proceso
 * reinicia, cada tenant pierde su wallet/historial/P&L por completo (solo
 * vive en memoria vía `createTenantStore`).
 *
 * DISEÑO: un módulo NUEVO, con su propio intervalo (no reutiliza el slot
 * de `startEngineSnapshotFlush`), que en cada tick itera
 * `tenantBotState.activeUids()` y persiste el snapshot de CADA uno vía
 * `persistenceService.persistEngineSnapshot(snapshot, uid)` — la misma
 * función primitiva ya usada por el bot compartido, solo que llamada una
 * vez por tenant activo en vez de una vez para 'default'. Mismo criterio
 * de aislamiento de fallas que `tenantExecution.js`: un error persistiendo
 * el snapshot de UN tenant nunca aborta el resto del pase.
 *
 * RESTORE: `restoreTenantSnapshot(uid)` se llama de forma perezosa (no en
 * el arranque del proceso, que no conoce de antemano qué uids existen)
 * — desde `POST /api/tenant-bot/toggle` cuando un tenant enciende su bot
 * por primera vez en un proceso nuevo. Best-effort: si no hay snapshot
 * previo (tenant nuevo) o Mongo no está listo, no-op silencioso — el
 * tenant simplemente arranca con el wallet inicial de siempre.
 *
 * ALCANCE: igual que `persistEngineSnapshot`/`restoreEngineSnapshot` del
 * bot compartido, esto persiste `equityCurve`/`dailyPnl`/`totalTrades`/
 * `tradeLog`/`counters` **y, desde el punto 7 (auditoría comité, sección
 * 12), también `wallets`** — los balances reales por-tenant, capturados
 * vía `getBalances(uid)` y reaplicados vía `setBalances(wallets, uid)`
 * al restaurar. Antes de este fix, un reinicio del proceso restauraba el
 * HISTORIAL/P&L reportado de cada tenant activo pero NO sus balances
 * exactos de wallet (quedaban en el estado inicial) — la misma
 * limitación que documentaba esta cabecera y que ahora queda cerrada,
 * igual que para el bot compartido (ver `arbitrageOrchestrator.js`).
 */

const tenantBotState = require('./tenantBotState');
const { getPnL, getTradeHistory, getBalances, setBalances } = require('../domain/wallet/walletManager');
const persistenceService = require('./persistenceService');
const { logger } = require('./logger');

function _log(...args)  { logger.info('tenantPersistence', args.map(String).join(' ')); }
function _warn(...args) { logger.warn('tenantPersistence', args.map(String).join(' ')); }

/**
 * _buildSnapshotForTenant — arma el snapshot de un tenant a partir de lo
 * que `walletManager` ya calcula por-uid. Deriva una `equityCurve`
 * acumulativa a partir del `tradeHistory` (mismo criterio que
 * `getPnL().maxDrawdown` ya usa internamente), ya que `arbitrage.state.js`
 * (donde vive `getEquityCurve()` para el bot compartido) no tiene
 * equivalente por-tenant.
 */
function _buildSnapshotForTenant(uid) {
  const history = getTradeHistory(uid) || [];
  let cum = 0;
  const equityCurve = history.map((t, i) => {
    cum = +(cum + (t.netProfit || 0)).toFixed(4);
    return { i, ts: t.ts, pnl: cum, profit: +(t.netProfit || 0).toFixed(4) };
  });
  const pnl = getPnL(null, null, uid);
  return {
    equityCurve,
    dailyPnl: pnl.realizedPnl || 0,
    totalTrades: pnl.totalTrades || 0,
    tradeLog: history.slice(-200),
    counters: {},
    // Punto 7: balances reales del tenant, capturados junto al resto del
    // snapshot para que un restart no los reinicie silenciosamente.
    wallets: getBalances(uid),
  };
}

/**
 * persistActiveTenantSnapshots — persiste el snapshot de cada tenant con
 * el bot encendido ahora mismo. No-op inmediato si no hay ninguno activo
 * (el caso de hoy para cualquier despliegue de un solo bot compartido).
 * @returns {Promise<{attempted:number, persisted:number}>}
 */
async function persistActiveTenantSnapshots() {
  const uids = tenantBotState.activeUids();
  let persisted = 0;
  for (const uid of uids) {
    try {
      const snap = _buildSnapshotForTenant(uid);
      await persistenceService.persistEngineSnapshot(snap, uid);
      persisted++;
    } catch (e) {
      _warn('Snapshot persist failed for tenant (non-fatal)', JSON.stringify({ uid, err: e.message }));
    }
  }
  return { attempted: uids.length, persisted };
}

/**
 * restoreTenantSnapshot — best-effort restore for a single tenant, called
 * when that tenant's bot is enabled (see tenantBot.routes.js). Never
 * throws — returns null on any failure (no snapshot, DB unavailable,
 * etc.), matching the shared bot's `restoreEngineSnapshot` contract.
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
async function restoreTenantSnapshot(uid) {
  try {
    const snap = await persistenceService.restoreEngineSnapshot(uid);
    // Punto 7: si el snapshot trae `wallets`, se aplican sobre el estado
    // vivo del tenant vía setBalances (que valida la forma antes de
    // aplicar y rechaza silenciosamente un blob corrupto o legacy). Antes
    // de este fix, `wallets` ni siquiera se persistía — el tenant siempre
    // arrancaba con el balance inicial sin importar su historial real.
    if (snap?.wallets) {
      const applied = setBalances(snap.wallets, uid);
      if (!applied) {
        _warn('Restored wallets blob had an invalid shape — kept initial balances', JSON.stringify({ uid }));
      }
    }
    return snap;
  } catch (e) {
    _warn('Snapshot restore failed for tenant (non-fatal)', JSON.stringify({ uid, err: e.message }));
    return null;
  }
}

let _tenantFlushInterval = null;

/**
 * startTenantPersistenceFlush — periodic flush loop, independent of the
 * shared bot's `startEngineSnapshotFlush` slot. Idempotent — calling
 * twice clears the previous interval first.
 * @param {number} [intervalMs]
 */
function startTenantPersistenceFlush(intervalMs = 30_000) {
  if (_tenantFlushInterval) clearInterval(_tenantFlushInterval);
  _tenantFlushInterval = setInterval(() => {
    persistActiveTenantSnapshots().catch((e) => {
      _warn('Tenant snapshot flush pass failed (non-fatal)', e.message);
    });
  }, intervalMs);
  _tenantFlushInterval.unref?.();
  _log(`Per-tenant snapshot flush started (every ${intervalMs / 1000}s)`);
}

function stopTenantPersistenceFlush() {
  if (_tenantFlushInterval) { clearInterval(_tenantFlushInterval); _tenantFlushInterval = null; }
}

module.exports = {
  persistActiveTenantSnapshots,
  restoreTenantSnapshot,
  startTenantPersistenceFlush,
  stopTenantPersistenceFlush,
  _buildSnapshotForTenant,
};
