/**
 * dailyStatsService.js — Kukora v12
 *
 * Agrega métricas de sesión por día y las persiste en MongoDB.
 * Responde /api/arbitrage/daily-stats con los últimos 7 días de operación real.
 *
 * Diseño:
 *   - Un documento por día (YYYY-MM-DD), upsert en cada flush.
 *   - Se alimenta de getTradeHistory() + getMissedSummary() — sin estado propio
 *     que pueda divergir de la fuente de verdad.
 *   - Flush periódico cada 5 min + flush inmediato en cada trade ejecutado.
 *   - Si MongoDB no está disponible, todo el módulo es no-op sin afectar el sistema.
 *
 * Schema por día:
 *   date          "2025-06-20"
 *   trades        número de trades ejecutados
 *   pnl           P&L neto acumulado (USD)
 *   fees          total de fees pagados
 *   winRate       % de trades con netProfit > 0
 *   captureRate   % de oportunidades viables ejecutadas
 *   bestOpp       { pair, spreadPct, netProfit, ts }
 *   pairBreakdown { "Binance→OKX": { count, pnl } }
 *   sessionsCount número de sesiones/reinicios del día
 *   updatedAt     timestamp del último flush
 */

'use strict';

const mongoose = require('mongoose');
const { logger } = require('./logger');

// Q2 (auditoría): consola limpia en producción
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _warn(...args) { if (_DEBUG) logger.warn('dailyStatsService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }

// ─── Schema ────────────────────────────────────────────────────────────────

// Audit fix 1.3: schema moved to server/models/DailyStatsDoc.js.
const DailyStatsDoc = require('./persistence/models/DailyStatsDoc');

// ─── Helpers ───────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

// ─── Data sources (inyectadas en init para evitar circular deps) ────────────

let _getTradeHistory = null;
let _getMissedSummary = null;
let _getBestOpportunitySeen = null;

/**
 * init — llamar desde arbitrage.routes.js con las funciones de fuente de datos.
 * Se hace así para evitar dependencias circulares (routes → engine → routes).
 */
function init({ getTradeHistory, getMissedSummary, getBestOpportunitySeen }) {
  _getTradeHistory       = getTradeHistory;
  _getMissedSummary      = getMissedSummary;
  _getBestOpportunitySeen = getBestOpportunitySeen;
}

// ─── Build snapshot del día actual ────────────────────────────────────────

/**
 * Bug real (encontrado leyendo el código, no reportado antes): esta función
 * usaba `_getTradeHistory()` completo — un buffer acumulado de hasta 500
 * trades de TODO el historial (`MAX_TRADE_HISTORY` en walletManager.js), sin
 * ningún filtro por fecha — para construir el snapshot "del día actual".
 * Resultado: un trade de hace una semana se contaba como "de hoy" en cada
 * flush, y cada documento diario persistido en Mongo terminaba mostrando
 * P&L/trades/winRate acumulados de todo el proceso, no de ese día — lo que
 * corrompe silenciosamente la tendencia día-a-día que expone
 * `getDailyStats()` (usada por el panel de historial).
 *
 * Fix: filtrar `trades` por `t.ts` (ISO string) comparando solo la porción
 * de fecha (YYYY-MM-DD) contra el `date` del snapshot. `date` es parametrizable
 * (default: hoy) para que el mismo helper sirva para reconstruir un día
 * pasado si hiciera falta, sin cambiar el comportamiento de `flush()`/
 * `getDailyStats()`, que siguen pidiendo el día actual por default.
 */
function buildDaySnapshot(date = todayKey()) {
  if (!_getTradeHistory) return null;

  const allTrades = _getTradeHistory();
  const trades   = allTrades.filter(t => typeof t.ts === 'string' && t.ts.slice(0, 10) === date);
  const missed   = _getMissedSummary ? _getMissedSummary() : null;
  const bestSeen = _getBestOpportunitySeen ? _getBestOpportunitySeen() : null;

  if (!trades.length) return null;

  const pnl    = trades.reduce((s, t) => s + (t.netProfit || 0), 0);
  const fees   = trades.reduce((s, t) => s + (t.totalFees || (t.buyFee||0) + (t.sellFee||0)), 0);
  const wins   = trades.filter(t => (t.netProfit || 0) > 0).length;
  const winRate = +(wins / trades.length * 100).toFixed(1);

  // Pair breakdown
  const pairBreakdown = {};
  for (const t of trades) {
    const key = `${t.buyExchange}→${t.sellExchange}`;
    if (!pairBreakdown[key]) pairBreakdown[key] = { count: 0, pnl: 0 };
    pairBreakdown[key].count++;
    pairBreakdown[key].pnl = +(pairBreakdown[key].pnl + (t.netProfit || 0)).toFixed(4);
  }

  // Best opportunity del día (desde bestOpportunitySeen del engine)
  let bestOpp = null;
  if (bestSeen) {
    bestOpp = {
      pair:      `${bestSeen.buyExchange}→${bestSeen.sellExchange}`,
      spreadPct: bestSeen.spreadPct,
      netProfit: bestSeen.netProfit,
      score:     bestSeen.score,
      ts:        bestSeen.ts || new Date().toISOString(),
    };
  }

  return {
    trades:        trades.length,
    pnl:           +pnl.toFixed(4),
    fees:          +fees.toFixed(4),
    winRate,
    // Nota (misma honestidad que dailyReportService.js): captureRate viene
    // de missedOpportunityTracker, acumulado desde el arranque del proceso,
    // no bucketed por día como `trades`/`pnl`/`fees` ya quedaron con este
    // fix. Se deja así — no es del día exacto — hasta que
    // missedOpportunityTracker.js soporte bucketing diario real.
    captureRate:   missed?.captureRate ?? null,
    bestOpp,
    pairBreakdown,
    updatedAt:     new Date(),
  };
}

// ─── Flush al MongoDB ──────────────────────────────────────────────────────

let _flushing = false;

async function flush() {
  if (!isMongoReady() || _flushing) return;
  _flushing = true;
  try {
    const snap = buildDaySnapshot();
    if (!snap) return;

    const date = todayKey();
    await DailyStatsDoc.findOneAndUpdate(
      { date },
      { $set: snap, $setOnInsert: { date, sessionsCount: 1 } },
      { upsert: true, new: true }
    );
  } catch (e) {
    // non-fatal — nunca interrumpir el trading por un fallo de stats
    _warn('[dailyStats] flush error (non-fatal):', e.message);
  } finally {
    _flushing = false;
  }
}

// Flush inmediato tras cada trade ejecutado (llamar desde routes)
function recordTradeExecuted() {
  flush().catch(() => {});
}

// ─── Periodic flush ───────────────────────────────────────────────────────

let _interval = null;

function startPeriodicFlush(intervalMs = 5 * 60 * 1000) { // 5 min default
  if (_interval) return;
  _interval = setInterval(() => { flush().catch(() => {}); }, intervalMs);
  _interval.unref?.();
}

// ─── Query — últimos N días ───────────────────────────────────────────────

/**
 * getDailyStats — devuelve los últimos `days` días de operación.
 * Incluye el día actual con datos en memoria (no espera al flush).
 */
async function getDailyStats(days = 7) {
  const result = [];

  // Día actual desde memoria (siempre fresco, independiente del flush)
  const todaySnap = buildDaySnapshot();
  const today = todayKey();
  if (todaySnap) {
    result.push({ date: today, ...todaySnap, isToday: true });
  }

  // Días anteriores desde MongoDB
  if (isMongoReady()) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      const docs = await DailyStatsDoc
        .find({ date: { $gte: cutoff.toISOString().slice(0, 10), $lt: today } })
        .sort({ date: -1 })
        .limit(days - 1)
        .lean();

      for (const doc of docs) {
        result.push({
          date:          doc.date,
          trades:        doc.trades,
          pnl:           doc.pnl,
          fees:          doc.fees,
          winRate:       doc.winRate,
          captureRate:   doc.captureRate,
          bestOpp:       doc.bestOpp,
          pairBreakdown: doc.pairBreakdown,
          sessionsCount: doc.sessionsCount,
          updatedAt:     doc.updatedAt,
          isToday:       false,
        });
      }
    } catch (e) {
      _warn('[dailyStats] getDailyStats query error (non-fatal):', e.message);
    }
  }

  // Ordenar por fecha desc
  result.sort((a, b) => b.date.localeCompare(a.date));

  // Agregar totales del período
  const totals = {
    days:       result.length,
    trades:     result.reduce((s, d) => s + (d.trades || 0), 0),
    pnl:        +result.reduce((s, d) => s + (d.pnl || 0), 0).toFixed(4),
    fees:       +result.reduce((s, d) => s + (d.fees || 0), 0).toFixed(4),
    avgWinRate: result.length
      ? +(result.reduce((s, d) => s + (d.winRate || 0), 0) / result.length).toFixed(1)
      : 0,
    avgCaptureRate: (() => {
      const withRate = result.filter(d => d.captureRate != null);
      return withRate.length
        ? +(withRate.reduce((s, d) => s + d.captureRate, 0) / withRate.length).toFixed(1)
        : null;
    })(),
  };

  return { days: result, totals };
}

module.exports = {
  init,
  flush,
  recordTradeExecuted,
  startPeriodicFlush,
  getDailyStats,
};
